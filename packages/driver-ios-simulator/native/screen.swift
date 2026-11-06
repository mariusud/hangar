// Streams one simulator's main display as H.264 on stdout.
//
// It reads the display's IOSurface through Xcode's private SimulatorKit API (loaded at runtime,
// so a missing symbol is an error message, not a crash at launch) and encodes only when the
// display reports damage, with VideoToolbox in low-latency mode.
//
// Usage: hangar-screen <udid> [--fps 60] [--bitrate 8000000] [--max-size 0]
// Stdin: "k\n" asks for a keyframe. EOF exits.
// Stdout, per frame: u32 length of the rest (big endian), u8 flags (1 = keyframe),
// f64 capture time in ms since the epoch, u16 width, u16 height, then Annex B NAL units.

import CoreMedia
import CoreVideo
import Foundation
import IOSurface
import VideoToolbox

func fail(_ code: String, _ message: String) -> Never {
  FileHandle.standardError.write("\(code): \(message)\n".data(using: .utf8)!)
  exit(1)
}

var args = Array(CommandLine.arguments.dropFirst())
guard let udid = args.first, !udid.hasPrefix("-") else {
  fail("USAGE", "hangar-screen <udid> [--fps 60] [--bitrate 8000000] [--max-size 0]")
}
func option(_ name: String, _ fallback: Int) -> Int {
  if let i = args.firstIndex(of: name), i + 1 < args.count, let v = Int(args[i + 1]) {
    return v
  }
  return fallback
}
let fps = option("--fps", 60)
let bitrate = option("--bitrate", 8_000_000)
let maxSize = option("--max-size", 0)

// MARK: SimulatorKit

let developerDir: String = {
  if let d = ProcessInfo.processInfo.environment["DEVELOPER_DIR"] {
    return d
  }
  let p = Process()
  p.executableURL = URL(fileURLWithPath: "/usr/bin/xcode-select")
  p.arguments = ["-p"]
  let out = Pipe()
  p.standardOutput = out
  try? p.run()
  p.waitUntilExit()
  return String(data: out.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)!.trimmingCharacters(in: .whitespacesAndNewlines)
}()

guard dlopen("/Library/Developer/PrivateFrameworks/CoreSimulator.framework/CoreSimulator", RTLD_NOW) != nil,
  dlopen(developerDir + "/Library/PrivateFrameworks/SimulatorKit.framework/SimulatorKit", RTLD_NOW) != nil
else {
  fail("SIMULATORKIT_MISSING", "Could not load CoreSimulator or SimulatorKit from \(developerDir).")
}

func send(_ o: AnyObject, _ sel: String) -> AnyObject? {
  let s = NSSelectorFromString(sel)
  guard o.responds(to: s) else {
    return nil
  }
  return o.perform(s)?.takeUnretainedValue()
}

func sendU16(_ o: AnyObject, _ sel: String) -> UInt16 {
  typealias F = @convention(c) (AnyObject, Selector) -> UInt16
  let s = NSSelectorFromString(sel)
  return unsafeBitCast(o.method(for: s), to: F.self)(o, s)
}

func register(_ o: AnyObject, _ sel: String, _ block: AnyObject) {
  typealias F = @convention(c) (AnyObject, Selector, NSUUID, AnyObject) -> Void
  let s = NSSelectorFromString(sel)
  unsafeBitCast(o.method(for: s), to: F.self)(o, s, NSUUID(), block)
}

guard let contextClass = NSClassFromString("SimServiceContext") as? NSObject.Type,
  let context = contextClass.perform(NSSelectorFromString("sharedServiceContextForDeveloperDir:error:"), with: developerDir, with: nil)?.takeUnretainedValue(),
  let deviceSet = context.perform(NSSelectorFromString("defaultDeviceSetWithError:"), with: nil)?.takeUnretainedValue(),
  let devices = send(deviceSet, "devices") as? [NSObject]
else {
  fail("SIMULATORKIT_CHANGED", "CoreSimulator's device set API changed in this Xcode.")
}
guard let device = devices.first(where: { (send($0, "UDID") as? NSUUID)?.uuidString == udid }) else {
  fail("DEVICE_NOT_FOUND", "No simulator \(udid).")
}
guard let io = send(device, "io"), let ports = send(io, "ioPorts") as? [AnyObject] else {
  fail("SIMULATORKIT_CHANGED", "The simulator has no IO ports. Is it booted?")
}
let surfaceProtocol = NSProtocolFromString("SimDisplayIOSurfaceRenderable")
let display: AnyObject? = ports.lazy.compactMap { send($0, "descriptor") }.first { d in
  guard let p = surfaceProtocol, d.conforms(to: p), let state = send(d, "state") else {
    return false
  }
  return sendU16(state, "displayClass") == 0
}
guard let display else {
  fail("NO_DISPLAY", "The simulator has no main display. Is it booted?")
}

// MARK: Encoder

let out = DispatchQueue(label: "out")
let work = DispatchQueue(label: "work")
let frameInterval = 1.0 / Double(fps)

var surface: IOSurfaceRef? = send(display, "framebufferSurface").map { unsafeBitCast($0, to: IOSurfaceRef.self) }
var session: VTCompressionSession?
var transfer: VTPixelTransferSession?
var scaledPool: CVPixelBufferPool?
var size = (width: 0, height: 0)
var wantKeyframe = true
var dirty = true
var lastEncode = 0.0
var timer: (at: Double, token: Int)?
var tokens = 0
var refreshes = 0

func now() -> Double {
  Date().timeIntervalSince1970 * 1000
}

func writeFrame(_ sample: CMSampleBuffer, captureMs: Double) {
  guard let data = CMSampleBufferGetDataBuffer(sample), let format = CMSampleBufferGetFormatDescription(sample) else {
    return
  }
  let attachments = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: false) as? [[CFString: Any]]
  let keyframe = !(attachments?.first?[kCMSampleAttachmentKey_NotSync] as? Bool ?? false)
  var payload = Data()
  let startCode: [UInt8] = [0, 0, 0, 1]
  if keyframe {
    var count = 0
    CMVideoFormatDescriptionGetH264ParameterSetAtIndex(format, parameterSetIndex: 0, parameterSetPointerOut: nil, parameterSetSizeOut: nil, parameterSetCountOut: &count, nalUnitHeaderLengthOut: nil)
    for i in 0..<count {
      var ptr: UnsafePointer<UInt8>?
      var len = 0
      CMVideoFormatDescriptionGetH264ParameterSetAtIndex(format, parameterSetIndex: i, parameterSetPointerOut: &ptr, parameterSetSizeOut: &len, parameterSetCountOut: nil, nalUnitHeaderLengthOut: nil)
      if let ptr {
        payload.append(contentsOf: startCode)
        payload.append(ptr, count: len)
      }
    }
  }
  var total = 0
  var base: UnsafeMutablePointer<CChar>?
  CMBlockBufferGetDataPointer(data, atOffset: 0, lengthAtOffsetOut: nil, totalLengthOut: &total, dataPointerOut: &base)
  guard let base else {
    return
  }
  // VideoToolbox gives 4-byte length prefixes; browsers and ffmpeg take Annex B start codes.
  var offset = 0
  while offset + 4 <= total {
    let len = base.advanced(by: offset).withMemoryRebound(to: UInt8.self, capacity: 4) { p in
      Int(p[0]) << 24 | Int(p[1]) << 16 | Int(p[2]) << 8 | Int(p[3])
    }
    payload.append(contentsOf: startCode)
    base.advanced(by: offset + 4).withMemoryRebound(to: UInt8.self, capacity: len) { payload.append($0, count: len) }
    offset += 4 + len
  }
  let dims = CMVideoFormatDescriptionGetDimensions(format)
  var header = Data(count: 17)
  header.withUnsafeMutableBytes { h in
    h.storeBytes(of: UInt32(13 + payload.count).bigEndian, toByteOffset: 0, as: UInt32.self)
    h.storeBytes(of: keyframe ? 1 : 0, toByteOffset: 4, as: UInt8.self)
    h.storeBytes(of: captureMs.bitPattern.bigEndian, toByteOffset: 5, as: UInt64.self)
    h.storeBytes(of: UInt16(dims.width).bigEndian, toByteOffset: 13, as: UInt16.self)
    h.storeBytes(of: UInt16(dims.height).bigEndian, toByteOffset: 15, as: UInt16.self)
  }
  out.async {
    FileHandle.standardOutput.write(header + payload)
  }
}

func setUp(width: Int, height: Int) {
  if let session {
    VTCompressionSessionInvalidate(session)
  }
  session = nil
  let spec = [kVTVideoEncoderSpecification_EnableLowLatencyRateControl: true] as CFDictionary
  let status = VTCompressionSessionCreate(
    allocator: nil, width: Int32(width), height: Int32(height), codecType: kCMVideoCodecType_H264,
    encoderSpecification: spec, imageBufferAttributes: nil, compressedDataAllocator: nil,
    outputCallback: { _, refcon, status, _, sample in
      guard status == noErr, let sample else {
        return
      }
      let captureMs = refcon.map { Double(bitPattern: UInt64(UInt(bitPattern: $0))) } ?? now()
      writeFrame(sample, captureMs: captureMs)
    }, refcon: nil, compressionSessionOut: &session)
  guard status == noErr, let session else {
    fail("ENCODER_FAILED", "VideoToolbox could not create an H.264 encoder (\(status)).")
  }
  let props: [CFString: Any] = [
    kVTCompressionPropertyKey_RealTime: true,
    kVTCompressionPropertyKey_AllowFrameReordering: false,
    kVTCompressionPropertyKey_ProfileLevel: kVTProfileLevel_H264_ConstrainedHigh_AutoLevel,
    kVTCompressionPropertyKey_AverageBitRate: bitrate,
    kVTCompressionPropertyKey_ExpectedFrameRate: fps,
    // Keyframes only when a viewer joins or asks; the screen is idle most of the time.
    kVTCompressionPropertyKey_MaxKeyFrameInterval: Int32.max,
    kVTCompressionPropertyKey_MaxKeyFrameIntervalDuration: 0,
  ]
  for (k, v) in props {
    VTSessionSetProperty(session, key: k, value: v as CFTypeRef)
  }
  VTCompressionSessionPrepareToEncodeFrames(session)
  size = (width, height)
  wantKeyframe = true
}

func scaled(_ src: CVPixelBuffer, _ w: Int, _ h: Int) -> CVPixelBuffer? {
  if transfer == nil {
    VTPixelTransferSessionCreate(allocator: nil, pixelTransferSessionOut: &transfer)
  }
  if scaledPool == nil {
    let attrs: [CFString: Any] = [
      kCVPixelBufferWidthKey: w, kCVPixelBufferHeightKey: h,
      kCVPixelBufferPixelFormatTypeKey: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
      kCVPixelBufferIOSurfacePropertiesKey: [:] as CFDictionary,
    ]
    CVPixelBufferPoolCreate(nil, nil, attrs as CFDictionary, &scaledPool)
  }
  var dst: CVPixelBuffer?
  guard let transfer, let scaledPool, CVPixelBufferPoolCreatePixelBuffer(nil, scaledPool, &dst) == kCVReturnSuccess, let dst else {
    return nil
  }
  return VTPixelTransferSessionTransferImage(transfer, from: src, to: dst) == noErr ? dst : nil
}

func encode(captureMs: Double) {
  guard let surface else {
    return
  }
  var pb: Unmanaged<CVPixelBuffer>?
  guard CVPixelBufferCreateWithIOSurface(nil, surface, nil, &pb) == kCVReturnSuccess, let src = pb?.takeRetainedValue() else {
    return
  }
  var buffer = src
  var w = IOSurfaceGetWidth(surface)
  var h = IOSurfaceGetHeight(surface)
  if maxSize > 0, max(w, h) > maxSize {
    let s = Double(maxSize) / Double(max(w, h))
    // Even sizes, which every H.264 decoder accepts.
    w = Int(Double(w) * s) & ~1
    h = Int(Double(h) * s) & ~1
    guard let small = scaled(src, w, h) else {
      return
    }
    buffer = small
  }
  if size != (w, h) {
    scaledPool = nil
    setUp(width: w, height: h)
  }
  guard let session else {
    return
  }
  var props: CFDictionary?
  if wantKeyframe {
    props = [kVTEncodeFrameOptionKey_ForceKeyFrame: true] as CFDictionary
    wantKeyframe = false
  }
  let pts = CMTime(value: Int64(captureMs * 1000), timescale: 1_000_000)
  let refcon = UnsafeMutableRawPointer(bitPattern: UInt(captureMs.bitPattern))
  VTCompressionSessionEncodeFrame(session, imageBuffer: buffer, presentationTimeStamp: pts, duration: .invalid, frameProperties: props, sourceFrameRefcon: refcon, infoFlagsOut: nil)
  VTCompressionSessionCompleteFrames(session, untilPresentationTimeStamp: pts)
}

// Encodes now if a frame interval has passed, else once at the end of the interval. After the
// screen settles, two more frames let the encoder sharpen what it blurred during motion.
func tick(_ token: Int) {
  guard timer?.token == token else {
    return
  }
  timer = nil
  let t = now()
  let wait = lastEncode + frameInterval * 1000 - t
  if wait > 0 {
    schedule(after: wait)
    return
  }
  if dirty {
    dirty = false
    refreshes = 2
    lastEncode = t
    encode(captureMs: t)
    schedule(after: 100)
  } else if refreshes > 0 {
    refreshes -= 1
    lastEncode = t
    encode(captureMs: t)
    if refreshes > 0 {
      schedule(after: 200)
    }
  }
}

// Keeps only the earliest pending tick, so new damage never waits behind a refresh.
func schedule(after ms: Double) {
  let at = now() + ms
  if let timer, timer.at <= at {
    return
  }
  tokens += 1
  let token = tokens
  timer = (at, token)
  work.asyncAfter(deadline: .now() + ms / 1000) { tick(token) }
}

func damaged() {
  work.async {
    dirty = true
    refreshes = 0
    schedule(after: 0)
  }
}

let onDamage: @convention(block) (AnyObject?) -> Void = { _ in damaged() }
let onSurface: @convention(block) (AnyObject?, AnyObject?) -> Void = { _, _ in
  work.async {
    surface = send(display, "framebufferSurface").map { unsafeBitCast($0, to: IOSurfaceRef.self) }
    wantKeyframe = true
  }
  damaged()
}
register(display, "registerCallbackWithUUID:damageRectanglesCallback:", onDamage as AnyObject)
register(display, "registerCallbackWithUUID:ioSurfacesChangeCallback:", onSurface as AnyObject)
damaged()

// Stdin: "k" asks for a keyframe (a new viewer joined). EOF means the agent went away.
Thread.detachNewThread {
  while let line = readLine() {
    if line == "k" {
      work.async {
        wantKeyframe = true
        dirty = true
        schedule(after: 0)
      }
    }
  }
  exit(0)
}

dispatchMain()

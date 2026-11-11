import SwiftUI

@main
struct HangarFixtureApp: App {
  var body: some Scene {
    WindowGroup {
      CounterView()
    }
  }
}

struct CounterView: View {
  @State private var count = 0

  var body: some View {
    VStack(spacing: 24) {
      Text("Count: \(count)")
        .accessibilityIdentifier("count")
      Button("Add one") { count += 1 }
        .accessibilityIdentifier("add")
    }
  }
}

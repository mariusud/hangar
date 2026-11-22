import XCTest

// Passes: a tap on the button counts up.
final class CounterTests: XCTestCase {
  func testAddOne() {
    let app = XCUIApplication()
    app.launch()
    app.buttons["add"].tap()
    XCTAssertEqual(app.staticTexts["count"].label, "Count: 1")
  }
}

// Fails on purpose, so the end-to-end test sees a failure with its message.
final class BrokenTests: XCTestCase {
  func testMissingButton() {
    let app = XCUIApplication()
    app.launch()
    XCTAssertTrue(app.buttons["missing"].waitForExistence(timeout: 1), "The missing button is not there")
  }
}

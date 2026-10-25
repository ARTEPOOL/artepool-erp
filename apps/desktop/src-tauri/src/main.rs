// No console window behind the app in release builds on Windows.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // The watchdog and the installer's autostart steps run without opening the app.
    if let Some(code) = artepool_desktop_lib::command_line() {
        std::process::exit(code);
    }
    artepool_desktop_lib::run();
}

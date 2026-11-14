mod commands;
mod data;
mod game;
mod paths;
mod utils;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            // The window icon is the one embedded in the executable from `bundle.icon`. Loading it
            // from the source tree (`env!("CARGO_MANIFEST_DIR")`) would bake the build machine's
            // absolute path into the binary, so on any other machine the icon file would not
            // exist, setup would fail and the app would close right after opening.
            //
            // The icon is cosmetic: a failure here must never abort startup.
            if let (Some(icon), Some(window)) = (
                app.default_window_icon().cloned(),
                app.get_webview_window("main"),
            ) {
                let _ = window.set_icon(icon);
            }

            Ok(())
        })
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            commands::game::get_initial_game_state,
            commands::saves::read_save,
            commands::saves::write_save,
            commands::saves::delete_save,
            commands::saves::reveal_saves_folder,
            commands::mods::list_mod_dialogue_ids,
            commands::mods::read_mod_dialogue,
            commands::mods::reveal_mods_folder,
            commands::settings::read_settings,
            commands::settings::write_settings,
            commands::settings::reveal_settings_folder,
            commands::settings::exit_app
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

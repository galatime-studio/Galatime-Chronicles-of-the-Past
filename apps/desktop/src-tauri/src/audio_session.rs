//! Labels the game's audio sessions in the Windows volume mixer.
//!
//! Audio played inside a WebView2 is rendered by Microsoft's `msedgewebview2.exe`
//! processes, so Windows lists it as "Microsoft Edge WebView2" instead of the host
//! application. WebView2 exposes no API to change that
//! (MicrosoftEdge/WebView2Feedback#2236), but the Core Audio session display name can be
//! stamped by the hosting process. Sessions are created when audio starts, so keep
//! polling and re-stamp any session owned by this app's WebView2 process tree.
//!
//! Windows-only: `lib.rs` only declares this module on `target_os = "windows"`.

use std::collections::HashMap;
use std::thread;
use std::time::Duration;

use windows::core::{Interface, HSTRING};
use windows::Win32::Foundation::CloseHandle;
use windows::Win32::Media::Audio::{
    eRender, IAudioSessionControl2, IAudioSessionManager2, IMMDeviceEnumerator, MMDeviceEnumerator,
    DEVICE_STATE_ACTIVE,
};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoTaskMemFree, CLSCTX_ALL, COINIT_MULTITHREADED,
};
use windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
};

/// Audio sessions appear when playback starts; this is fast enough to label the session
/// before the user opens the volume mixer, without polling the audio stack constantly.
const POLL_INTERVAL: Duration = Duration::from_secs(2);
const WEBVIEW_EXE: &str = "msedgewebview2.exe";
const MAX_PROCESS_DEPTH: usize = 32;

/// Starts a background thread that names the app's WebView2 audio sessions after
/// `app_name`. Failures are ignored: this is cosmetic and must never affect playback.
pub fn label_webview_audio(app_name: String) {
    thread::spawn(move || {
        unsafe {
            // The thread owns its COM apartment (MTA), so the WASAPI objects can be used
            // from here without touching the UI thread's STA.
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        }

        let icon = std::env::current_exe()
            .ok()
            .map(|path| path.to_string_lossy().into_owned());

        loop {
            let _ = stamp_sessions(&app_name, icon.as_deref());
            thread::sleep(POLL_INTERVAL);
        }
    });
}

fn stamp_sessions(app_name: &str, icon: Option<&str>) -> windows::core::Result<()> {
    let own_pid = std::process::id();
    let processes = snapshot_processes();

    unsafe {
        let enumerator: IMMDeviceEnumerator = CoCreateInstance(
            &MMDeviceEnumerator,
            None::<&windows::core::IUnknown>,
            CLSCTX_ALL,
        )?;
        let devices = enumerator.EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE)?;

        for device_index in 0..devices.GetCount()? {
            let Ok(device) = devices.Item(device_index) else {
                continue;
            };
            let Ok(manager) = device.Activate::<IAudioSessionManager2>(CLSCTX_ALL, None) else {
                continue;
            };
            let Ok(sessions) = manager.GetSessionEnumerator() else {
                continue;
            };

            for session_index in 0..sessions.GetCount()? {
                let Ok(control) = sessions.GetSession(session_index) else {
                    continue;
                };
                let Ok(control) = control.cast::<IAudioSessionControl2>() else {
                    continue;
                };
                let Ok(pid) = control.GetProcessId() else {
                    continue;
                };
                if pid == 0 || !is_webview_owned(pid, own_pid, &processes) {
                    continue;
                }

                if display_name(&control).as_deref() != Some(app_name) {
                    let name = HSTRING::from(app_name);
                    let _ = control.SetDisplayName(&name, std::ptr::null());
                }

                if let Some(icon) = icon {
                    // `SetIconPath` accepts an .exe: Windows extracts its first icon, so
                    // the mixer shows the game's icon without shipping a separate .ico.
                    if icon_path(&control).as_deref() != Some(icon) {
                        let path = HSTRING::from(icon);
                        let _ = control.SetIconPath(&path, std::ptr::null());
                    }
                }
            }
        }
    }

    Ok(())
}

/// Reads the session display name, freeing the string allocated by Core Audio.
fn display_name(control: &IAudioSessionControl2) -> Option<String> {
    unsafe {
        let value = control.GetDisplayName().ok()?;
        if value.is_null() {
            return None;
        }
        let name = value.to_string().ok();
        CoTaskMemFree(Some(value.0 as *const core::ffi::c_void));
        name
    }
}

/// Reads the session icon path, freeing the string allocated by Core Audio.
fn icon_path(control: &IAudioSessionControl2) -> Option<String> {
    unsafe {
        let value = control.GetIconPath().ok()?;
        if value.is_null() {
            return None;
        }
        let path = value.to_string().ok();
        CoTaskMemFree(Some(value.0 as *const core::ffi::c_void));
        path
    }
}

/// Maps process id to `(parent id, executable name)` for the current process tree.
fn snapshot_processes() -> HashMap<u32, (u32, String)> {
    let mut processes = HashMap::new();

    unsafe {
        let Ok(snapshot) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else {
            return processes;
        };

        let mut entry = PROCESSENTRY32W {
            dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
            ..Default::default()
        };

        if Process32FirstW(snapshot, &mut entry).is_ok() {
            loop {
                let name_len = entry
                    .szExeFile
                    .iter()
                    .position(|&unit| unit == 0)
                    .unwrap_or(entry.szExeFile.len());
                let name = String::from_utf16_lossy(&entry.szExeFile[..name_len]);
                processes.insert(entry.th32ProcessID, (entry.th32ParentProcessID, name));

                if Process32NextW(snapshot, &mut entry).is_err() {
                    break;
                }
            }
        }

        let _ = CloseHandle(snapshot);
    }

    processes
}

/// True when `pid` is a WebView2 process whose ancestor chain reaches this app.
fn is_webview_owned(pid: u32, own_pid: u32, processes: &HashMap<u32, (u32, String)>) -> bool {
    let Some((_, exe)) = processes.get(&pid) else {
        return false;
    };
    if !exe.eq_ignore_ascii_case(WEBVIEW_EXE) {
        return false;
    }

    let mut current = pid;
    for _ in 0..MAX_PROCESS_DEPTH {
        let Some((parent, _)) = processes.get(&current) else {
            return false;
        };
        if *parent == own_pid {
            return true;
        }
        if *parent == 0 || *parent == current {
            return false;
        }
        current = *parent;
    }

    false
}

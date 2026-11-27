use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::{Manager, PhysicalPosition, PhysicalSize, Window, WindowEvent};

#[derive(Clone, Serialize, Deserialize)]
struct Bounds {
    monitor: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}
#[derive(Default, Clone, Serialize, Deserialize)]
pub struct Placement {
    normal: Option<Bounds>,
    maximized: bool,
}
const KEY: &str = "window.main.v1";

fn capture(w: &Window, placement: &mut Placement) {
    if w.is_minimized().unwrap_or(true) || w.is_fullscreen().unwrap_or(true) {
        return;
    }
    let Ok(maximized) = w.is_maximized() else {
        return;
    };
    placement.maximized = maximized;
    if maximized {
        if let (Some(bounds), Ok(Some(m))) = (placement.normal.as_mut(), w.current_monitor()) {
            bounds.monitor = m.name().cloned().unwrap_or_default();
        }
        return;
    }
    if let (Ok(Some(m)), Ok(p), Ok(s)) = (w.current_monitor(), w.outer_position(), w.inner_size()) {
        if s.width == 0 || s.height == 0 {
            return;
        }
        let d = m.scale_factor();
        let area = m.work_area();
        placement.normal = Some(Bounds {
            monitor: m.name().cloned().unwrap_or_default(),
            x: (p.x as f64 - area.position.x as f64) / d,
            y: (p.y as f64 - area.position.y as f64) / d,
            width: s.width as f64 / d,
            height: s.height as f64 / d,
        });
    }
}
fn inner_extent(saved: f64, minimum: f64, scale: f64, work_area: u32, frame: u32) -> u32 {
    (saved.max(minimum) * scale)
        .round()
        .min(work_area.saturating_sub(frame) as f64) as u32
}

pub fn restore(app: &tauri::App, conn: &Connection) {
    let Some(w) = app.get_webview_window("main") else {
        return;
    };
    let saved: Option<String> = conn
        .query_row("SELECT value FROM app_setting WHERE key=?1", [KEY], |r| {
            r.get(0)
        })
        .optional()
        .ok()
        .flatten();
    let mut p = saved
        .and_then(|s| serde_json::from_str::<Placement>(&s).ok())
        .unwrap_or(Placement {
            normal: None,
            maximized: true,
        });
    let mut restored = false;
    if let Some(b) = &p.normal {
        if [b.width, b.height, b.x, b.y].iter().all(|v| v.is_finite())
            && b.width > 0.0
            && b.height > 0.0
        {
            let monitor = w
                .available_monitors()
                .ok()
                .and_then(|ms| ms.into_iter().find(|m| m.name() == Some(&b.monitor)))
                .or_else(|| w.current_monitor().ok().flatten());
            if let Some(m) = monitor {
                let d = m.scale_factor();
                let area = m.work_area();
                let _ = w.set_position(PhysicalPosition::new(area.position.x, area.position.y));
                let (frame_w, frame_h) = match (w.outer_size(), w.inner_size()) {
                    (Ok(outer), Ok(inner)) => (
                        outer.width.saturating_sub(inner.width),
                        outer.height.saturating_sub(inner.height),
                    ),
                    _ => (0, 0),
                };
                let width = inner_extent(b.width, 1200.0, d, area.size.width, frame_w);
                let height = inner_extent(b.height, 700.0, d, area.size.height, frame_h);
                if w.set_size(PhysicalSize::new(width, height)).is_ok() {
                    let outer = w.outer_size().unwrap_or(PhysicalSize::new(width, height));
                    let x = (b.x * d).clamp(0., area.size.width.saturating_sub(outer.width) as f64);
                    let y =
                        (b.y * d).clamp(0., area.size.height.saturating_sub(outer.height) as f64);
                    restored = w
                        .set_position(PhysicalPosition::new(
                            area.position.x + x as i32,
                            area.position.y + y as i32,
                        ))
                        .is_ok();
                }
            }
        }
    }
    let maximize = p.maximized || !restored;
    capture(&w.as_ref().window(), &mut p);
    if maximize {
        let _ = w.maximize();
        p.maximized = true;
    }
    app.manage(Mutex::new(p));
}
pub fn observe(w: &Window, event: &WindowEvent) {
    if w.label() != "main"
        || !matches!(
            event,
            WindowEvent::Moved(_) | WindowEvent::Resized(_) | WindowEvent::CloseRequested { .. }
        )
    {
        return;
    }
    let Some(state) = w.try_state::<Mutex<Placement>>() else {
        return;
    };
    let Ok(mut p) = state.lock() else { return };
    capture(w, &mut p);
    if matches!(event, WindowEvent::CloseRequested { .. }) {
        if let (Some(db), Ok(value)) = (
            w.try_state::<crate::db::DbState>(),
            serde_json::to_string(&*p),
        ) {
            if let Ok(conn) = db.0.lock() {
                let _=conn.execute("INSERT INTO app_setting(key,value,updated_at_ms) VALUES(?1,?2,?3) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at_ms=excluded.updated_at_ms", params![KEY,value,crate::db::now_ms() as i64]);
            };
        }
    }
}

#[cfg(test)]
mod tests {
    use super::inner_extent;

    #[test]
    fn restore_sizes_use_target_dpi_and_fit_the_monitor_work_area() {
        assert_eq!(inner_extent(1300.0, 1200.0, 1.5, 2560, 16), 1950);
        assert_eq!(inner_extent(500.0, 700.0, 1.25, 1080, 48), 875);
        assert_eq!(inner_extent(1600.0, 1200.0, 2.0, 1280, 20), 1260);
        assert_eq!(inner_extent(900.0, 700.0, 1.0, 24, 32), 0);
    }
}

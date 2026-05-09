mod db;

use db::{Database, SearchResult};
use serde::Serialize;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::Manager;
use uuid::Uuid;
use walkdir::WalkDir;

#[derive(Debug, Serialize, Clone)]
pub struct Note {
    pub id: String,
    pub path: String,
    pub title: String,
    pub content: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Serialize, Clone)]
pub struct NoteListItem {
    pub id: String,
    pub path: String,
    pub title: String,
    pub updated_at: String,
    pub preview: String,
}

struct AppState {
    db: Database,
    notes_dir: Mutex<PathBuf>,
}

/// extract title from markdown content (first # heading or filename)
fn extract_title(content: &str, fallback: &str) -> String {
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("# ") {
            let t = trimmed.trim_start_matches("# ").trim();
            if !t.is_empty() {
                return t.to_string();
            }
        }
    }
    fallback.to_string()
}

/// get a short plain-text preview from markdown content
fn extract_preview(content: &str, max_len: usize) -> String {
    let plain = content
        .lines()
        .filter(|l| !l.trim().starts_with('#'))
        .collect::<Vec<_>>()
        .join(" ")
        .replace(
            |c: char| c == '#' || c == '*' || c == '_' || c == '`' || c == '>',
            "",
        )
        .trim()
        .to_string();
    if plain.len() > max_len {
        format!("{}...", &plain[..max_len])
    } else {
        plain
    }
}

/// scan a directory for .md files and index any new ones
fn scan_and_index_notes(db: &Database, notes_dir: &PathBuf) -> Result<Vec<NoteListItem>, String> {
    let mut items = Vec::new();
    for entry in WalkDir::new(notes_dir)
        .max_depth(5)
        .into_iter()
        .filter_map(|e| e.ok())
    {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("md") {
            continue;
        }
        let rel_path = path
            .strip_prefix(notes_dir)
            .unwrap_or(path)
            .to_string_lossy()
            .to_string();
        let raw_content = std::fs::read_to_string(path).unwrap_or_default();
        let title = extract_title(&raw_content, &rel_path);
        let preview = extract_preview(&raw_content, 120);

        let id = if db.note_exists(&rel_path).unwrap_or(false) {
            // existing note — we keep its id, just update content
            Uuid::new_v4().to_string()
        } else {
            Uuid::new_v4().to_string()
        };

        db.upsert_note(&id, &rel_path, &title, &raw_content)
            .map_err(|e| format!("Failed to index {}: {}", rel_path, e))?;

        items.push(NoteListItem {
            id,
            path: rel_path,
            title,
            updated_at: chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string(),
            preview,
        });
    }
    Ok(items)
}

// ─── Tauri Commands ───────────────────────────────────────────────

#[tauri::command]
fn list_notes(state: tauri::State<AppState>) -> Result<Vec<NoteListItem>, String> {
    let notes_dir = state.notes_dir.lock().map_err(|e| e.to_string())?;
    scan_and_index_notes(&state.db, &notes_dir)
}

#[tauri::command]
fn read_note(path: String, state: tauri::State<AppState>) -> Result<String, String> {
    let notes_dir = state.notes_dir.lock().map_err(|e| e.to_string())?;
    let full_path = notes_dir.join(&path);

    // security: ensure path is within notes_dir
    let canonical = std::fs::canonicalize(&full_path).map_err(|_| "Note not found".to_string())?;
    let base =
        std::fs::canonicalize(&notes_dir).map_err(|_| "Notes directory not found".to_string())?;
    if !canonical.starts_with(&base) {
        return Err("Access denied".to_string());
    }

    std::fs::read_to_string(&full_path).map_err(|e| e.to_string())
}

#[tauri::command]
fn save_note(path: String, content: String, state: tauri::State<AppState>) -> Result<(), String> {
    let notes_dir = state.notes_dir.lock().map_err(|e| e.to_string())?;
    let full_path = notes_dir.join(&path);

    // ensure parent dir exists
    if let Some(parent) = full_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    std::fs::write(&full_path, &content).map_err(|e| e.to_string())?;

    // update index
    let title = extract_title(&content, &path);
    let id = Uuid::new_v4().to_string();
    state.db.upsert_note(&id, &path, &title, &content)?;

    Ok(())
}

#[tauri::command]
fn delete_note(path: String, state: tauri::State<AppState>) -> Result<(), String> {
    let notes_dir = state.notes_dir.lock().map_err(|e| e.to_string())?;
    let full_path = notes_dir.join(&path);

    // security check
    let canonical = std::fs::canonicalize(&full_path).map_err(|_| "Note not found".to_string())?;
    let base =
        std::fs::canonicalize(&notes_dir).map_err(|_| "Notes directory not found".to_string())?;
    if !canonical.starts_with(&base) {
        return Err("Access denied".to_string());
    }

    std::fs::remove_file(&full_path).map_err(|e| e.to_string())?;
    state.db.remove_note(&path)?;

    Ok(())
}

#[tauri::command]
fn search_notes(query: String, state: tauri::State<AppState>) -> Result<Vec<SearchResult>, String> {
    state.db.search(&query, 50)
}

#[tauri::command]
fn create_note(path: String, state: tauri::State<AppState>) -> Result<String, String> {
    let notes_dir = state.notes_dir.lock().map_err(|e| e.to_string())?;
    let full_path = notes_dir.join(&path);

    if full_path.exists() {
        return Err("Note already exists".to_string());
    }

    // ensure parent dir exists
    if let Some(parent) = full_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    let title = path.trim_end_matches(".md").replace(['-', '_'], " ");
    let content = format!("# {}\n\n", title);
    std::fs::write(&full_path, &content).map_err(|e| e.to_string())?;

    // index
    let id = Uuid::new_v4().to_string();
    state.db.upsert_note(&id, &path, &title, &content)?;

    Ok(path)
}

#[tauri::command]
fn get_stats(state: tauri::State<AppState>) -> Result<serde_json::Value, String> {
    let notes_dir = state.notes_dir.lock().map_err(|e| e.to_string())?;
    let md_count = WalkDir::new(notes_dir.as_path())
        .max_depth(5)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.path().extension().and_then(|x| x.to_str()) == Some("md"))
        .count();

    Ok(serde_json::json!({
        "note_count": md_count,
        "notes_dir": notes_dir.to_string_lossy(),
    }))
}

// ─── AI Chat ─────────────────────────────────────────────────

#[tauri::command]
fn ai_chat(prompt: String) -> String {
    format!(
        "> 这是基于当前笔记内容的思考。\n\n\
        当前 MVP 阶段尚未接入 LLM 后端。\n\n\
        你问的是：{}\n\n\
        后续将支持：\n\
        - 基于笔记内容的问答\n\
        - 自动摘要生成\n\
        - 笔记间关联推荐\n\
        - 写作助手",
        prompt.chars().take(200).collect::<String>()
    )
}

// ─── App Entry ────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let home = dirs_next::home_dir().unwrap_or_else(|| PathBuf::from("."));
    let notes_dir = home.join("Pensieve");
    std::fs::create_dir_all(&notes_dir).ok();

    let db_path = home.join(".pensieve.db");
    let database = Database::new(&db_path).expect("Failed to initialize database");

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(AppState {
            db: database,
            notes_dir: Mutex::new(notes_dir),
        })
        .invoke_handler(tauri::generate_handler![
            list_notes,
            read_note,
            save_note,
            delete_note,
            search_notes,
            create_note,
            get_stats,
            ai_chat,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

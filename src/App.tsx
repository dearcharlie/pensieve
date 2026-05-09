import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  FileText,
  Search,
  Plus,
  Trash2,
  Save,
  Moon,
  Sun,
  MessageSquare,
  Send,
  FolderTree,
  PanelRightClose,
  PanelRightOpen,
} from "lucide-react";
import "./App.css";

interface NoteListItem {
  id: string;
  path: string;
  title: string;
  updated_at: string;
  preview: string;
}

interface SearchResult {
  path: string;
  title: string;
  snippet: string;
  score: number;
}

function App() {
  const [notes, setNotes] = useState<NoteListItem[]>([]);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [content, setContent] = useState("");
  const [originalContent, setOriginalContent] = useState("");
  const [isDirty, setIsDirty] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResult[] | null>(null);
  const [isDark, setIsDark] = useState(true);
  const [showPreview, setShowPreview] = useState(true);
  const [showChat, setShowChat] = useState(false);
  const [chatMessages, setChatMessages] = useState<{ role: string; content: string }[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [newNoteName, setNewNoteName] = useState("");
  const [showNewNote, setShowNewNote] = useState(false);
  const [stats, setStats] = useState<{ note_count: number; notes_dir: string } | null>(null);

  // load notes list
  const loadNotes = useCallback(async () => {
    try {
      const list = await invoke<NoteListItem[]>("list_notes");
      setNotes(list);
      const s = await invoke<{ note_count: number; notes_dir: string }>("get_stats");
      setStats(s);
    } catch (e) {
      console.error("Failed to load notes:", e);
    }
  }, []);

  useEffect(() => {
    loadNotes();
  }, [loadNotes]);

  // read selected note
  const openNote = useCallback(async (path: string) => {
    try {
      const text = await invoke<string>("read_note", { path });
      // clear search on open
      setSearchQuery("");
      setSearchResults(null);
      setSelectedPath(path);
      setContent(text);
      setOriginalContent(text);
      setIsDirty(false);
    } catch (e) {
      console.error("Failed to read note:", e);
    }
  }, []);

  const saveNote = useCallback(async () => {
    if (!selectedPath) return;
    try {
      await invoke("save_note", { path: selectedPath, content });
      setOriginalContent(content);
      setIsDirty(false);
      loadNotes();
    } catch (e) {
      console.error("Failed to save note:", e);
    }
  }, [selectedPath, content, loadNotes]);

  const deleteNote = useCallback(async () => {
    if (!selectedPath) return;
    if (!confirm(`Delete "${selectedPath}"?`)) return;
    try {
      await invoke("delete_note", { path: selectedPath });
      setSelectedPath(null);
      setContent("");
      setOriginalContent("");
      setIsDirty(false);
      loadNotes();
    } catch (e) {
      console.error("Failed to delete note:", e);
    }
  }, [selectedPath, loadNotes]);

  const createNote = useCallback(async () => {
    const name = newNoteName.trim();
    if (!name) return;
    const path = name.endsWith(".md") ? name : `${name}.md`;
    try {
      await invoke("create_note", { path });
      setNewNoteName("");
      setShowNewNote(false);
      loadNotes();
      openNote(path);
    } catch (e) {
      console.error("Failed to create note:", e);
    }
  }, [newNoteName, loadNotes, openNote]);

  const doSearch = useCallback(
    async (query: string) => {
      setSearchQuery(query);
      if (!query.trim()) {
        setSearchResults(null);
        return;
      }
      try {
        const results = await invoke<SearchResult[]>("search_notes", {
          query: query.trim(),
        });
        setSearchResults(results);
      } catch (e) {
        console.error("Search failed:", e);
      }
    },
    []
  );

  // keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        if (isDirty) saveNote();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [isDirty, saveNote]);

  // clean split path into parts
  const pathParts = (p: string) => p.split("/");

  // build tree from flat paths
  const buildTree = (items: NoteListItem[]) => {
    const tree: Record<string, { dirs: Set<string>; files: NoteListItem[] }> = {};
    for (const item of items) {
      const parts = pathParts(item.path);
      if (parts.length === 1) {
        const key = "__root__";
        if (!tree[key]) tree[key] = { dirs: new Set(), files: [] };
        tree[key].files.push(item);
      } else {
        const dir = parts.slice(0, -1).join("/");
        if (!tree[dir]) tree[dir] = { dirs: new Set(), files: [] };
        tree[dir].files.push(item);
        // register parent dirs
        for (let i = 1; i < parts.length; i++) {
          const parent = parts.slice(0, i).join("/") || "__root__";
          if (!tree[parent]) tree[parent] = { dirs: new Set(), files: [] };
          tree[parent].dirs.add(parts[i]);
        }
      }
    }
    return tree;
  };

  const tree = buildTree(notes);
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set());

  const toggleDir = (dir: string) => {
    const next = new Set(expandedDirs);
    if (next.has(dir)) next.delete(dir);
    else next.add(dir);
    setExpandedDirs(next);
  };

  const renderSidebar = () => {
    const rootFiles = tree["__root__"]?.files || [];
    const dirs = Array.from(tree["__root__"]?.dirs || []).sort();

    return (
      <div className="file-list">
        {rootFiles.map((note) => (
          <div
            key={note.path}
            className={`file-item ${selectedPath === note.path ? "active" : ""}`}
            onClick={() => openNote(note.path)}
            title={note.path}
          >
            <FileText size={14} />
            <span>{note.title || note.path.replace(".md", "")}</span>
          </div>
        ))}
        {dirs.map((d) => (
          <div key={d}>
            <div
              className={`file-item dir-item ${expandedDirs.has(d) ? "expanded" : ""}`}
              onClick={() => toggleDir(d)}
            >
              <span className="dir-arrow">{expandedDirs.has(d) ? "▼" : "▶"}</span>
              <span>{d}</span>
            </div>
            {expandedDirs.has(d) &&
              tree[d]?.files.map((note) => (
                <div
                  key={note.path}
                  className={`file-item file-sub ${selectedPath === note.path ? "active" : ""}`}
                  onClick={() => openNote(note.path)}
                >
                  <FileText size={14} />
                  <span>{note.title || note.path.split("/").pop()?.replace(".md", "")}</span>
                </div>
              ))}
          </div>
        ))}
      </div>
    );
  };

  const renderSearchResults = () => {
    if (!searchResults || !searchQuery.trim()) return null;
    if (searchResults.length === 0) {
      return (
        <div className="search-empty">
          <p>No results for "{searchQuery}"</p>
        </div>
      );
    }
    return (
      <div className="search-results">
        <div className="search-count">{searchResults.length} results</div>
        {searchResults.map((r, i) => (
          <div
            key={i}
            className="search-result-item"
            onClick={() => openNote(r.path)}
          >
            <div className="result-title">{r.title}</div>
            <div className="result-path">{r.path}</div>
            <div
              className="result-snippet"
              dangerouslySetInnerHTML={{ __html: r.snippet }}
            />
          </div>
        ))}
      </div>
    );
  };

  const sendChat = async () => {
    if (!chatInput.trim() || !selectedPath) return;
    const msg = chatInput.trim();
    setChatInput("");
    const newMessages = [
      ...chatMessages,
      { role: "user", content: msg },
      { role: "assistant", content: "思考中..." },
    ];
    setChatMessages(newMessages);

    // send to the AI via Tauri shell or HTTP
    try {
      // For MVP, use a simple approach: call the system's AI via shell
      const prompt = `以下是用户笔记的内容:\n\n${content}\n\n---\n\n用户问题: ${msg}\n\n请根据笔记内容回答。`;
      const result = await invoke<string>("ai_chat", { prompt });
      setChatMessages([
        ...newMessages.slice(0, -1),
        { role: "assistant", content: result },
      ]);
    } catch {
      // fallback: just acknowledge
      setChatMessages([
        ...newMessages.slice(0, -1),
        {
          role: "assistant",
          content: "（AI 聊天功能需要配置 LLM 后端，当前为 MVP 暂未接入）",
        },
      ]);
    }
  };

  return (
    <div className={`app ${isDark ? "dark" : "light"}`}>
      {/* Top bar */}
      <header className="topbar">
        <div className="topbar-left">
          <span className="brand">隙</span>
          <div className="search-box">
            <Search size={16} />
            <input
              type="text"
              placeholder="搜索笔记..."
              value={searchQuery}
              onChange={(e) => doSearch(e.target.value)}
            />
          </div>
        </div>
        <div className="topbar-right">
          <button
            className="icon-btn"
            onClick={() => setShowChat(!showChat)}
            title="AI 聊天"
          >
            <MessageSquare size={16} />
          </button>
          <button className="icon-btn" onClick={() => setShowNewNote(true)} title="新建笔记">
            <Plus size={16} />
          </button>
          <button className="icon-btn" onClick={() => setIsDark(!isDark)} title="切换主题">
            {isDark ? <Sun size={16} /> : <Moon size={16} />}
          </button>
        </div>
      </header>

      {/* New note dialog */}
      {showNewNote && (
        <div className="modal-overlay" onClick={() => setShowNewNote(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>新建笔记</h3>
            <input
              type="text"
              placeholder="笔记名称 (如: ideas.md 或 projects/idea.md)"
              value={newNoteName}
              onChange={(e) => setNewNoteName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && createNote()}
              autoFocus
            />
            <div className="modal-actions">
              <button onClick={() => setShowNewNote(false)}>取消</button>
              <button className="primary" onClick={createNote}>
                创建
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="main-layout">
        {/* Sidebar */}
        <aside className="sidebar">
          <div className="sidebar-header">
            <FolderTree size={16} />
            <span>笔记 ({stats?.note_count || 0})</span>
          </div>
          {renderSidebar()}
        </aside>

        {/* Content area */}
        <main className="content">
          {searchQuery ? (
            renderSearchResults()
          ) : selectedPath ? (
            <div className="editor-area">
              <div className="editor-header">
                <span className="editor-path">{selectedPath}</span>
                <div className="editor-actions">
                  <button
                    className={`icon-btn ${showPreview ? "active" : ""}`}
                    onClick={() => setShowPreview(!showPreview)}
                    title={showPreview ? "隐藏预览" : "显示预览"}
                  >
                    {showPreview ? <PanelRightClose size={16} /> : <PanelRightOpen size={16} />}
                  </button>
                  <button
                    className="icon-btn"
                    onClick={deleteNote}
                    title="删除笔记"
                    disabled={!selectedPath}
                  >
                    <Trash2 size={16} />
                  </button>
                  <button
                    className={`icon-btn save-btn ${isDirty ? "dirty" : ""}`}
                    onClick={saveNote}
                    disabled={!isDirty}
                    title={isDirty ? "保存 (⌘S)" : "已保存"}
                  >
                    <Save size={16} />
                    {isDirty && <span className="save-dot" />}
                  </button>
                </div>
              </div>
              <div className="editor-body">
                <textarea
                  className="editor-textarea"
                  value={content}
                  onChange={(e) => {
                    setContent(e.target.value);
                    setIsDirty(e.target.value !== originalContent);
                  }}
                  placeholder="用 Markdown 写点什么..."
                  spellCheck={false}
                />
                {showPreview && (
                  <div className="editor-preview">
                    <Markdown remarkPlugins={[remarkGfm]}>{content}</Markdown>
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="empty-state">
              <div className="empty-icon">
                <FileText size={64} />
              </div>
              <h2>欢迎使用 隙</h2>
              <p>选择左侧一篇笔记，或新建一篇开始</p>
              <button className="primary" onClick={() => setShowNewNote(true)}>
                <Plus size={16} /> 新建笔记
              </button>
            </div>
          )}

          {/* AI Chat panel */}
          {showChat && selectedPath && (
            <div className="chat-panel">
              <div className="chat-header">
                <MessageSquare size={16} />
                <span>AI 助手</span>
                <button className="icon-btn" onClick={() => setShowChat(false)}>✕</button>
              </div>
              <div className="chat-messages">
                {chatMessages.length === 0 && (
                  <div className="chat-empty">
                    基于当前笔记内容提问
                  </div>
                )}
                {chatMessages.map((m, i) => (
                  <div key={i} className={`chat-msg ${m.role}`}>
                    <div className="msg-content">{m.content}</div>
                  </div>
                ))}
              </div>
              <div className="chat-input">
                <input
                  type="text"
                  placeholder="问关于笔记的问题..."
                  value={chatInput}
                  onChange={(e) => setChatInput(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && sendChat()}
                />
                <button className="icon-btn" onClick={sendChat}>
                  <Send size={16} />
                </button>
              </div>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}

export default App;

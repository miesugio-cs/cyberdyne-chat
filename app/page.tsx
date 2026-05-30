'use client'

import { useEffect, useRef, useState } from 'react'
import { io, Socket } from 'socket.io-client'

// ---- Types ----
interface Channel { id: number; name: string; createdAt: string }
interface Message { id: number; username: string; content: string; channelId: number; createdAt: string }
interface ThemeColors { sidebar: string; chat: string; accent: string }

// ---- Constants ----
const DEFAULT_COLORS: ThemeColors = { sidebar: '#1f2937', chat: '#111827', accent: '#2563eb' }

// ---- Utilities ----
function avatarBgColor(username: string): string {
  const palette = ['#e74c3c','#e67e22','#f39c12','#2ecc71','#1abc9c','#3498db','#9b59b6','#e91e63','#00bcd4','#ff5722']
  let h = 0
  for (const c of username) h = (h * 31 + c.charCodeAt(0)) | 0
  return palette[Math.abs(h) % palette.length]
}

// Canvas でリサイズ（center-crop → 128×128 JPEG）してから base64 data URL を返す
function resizeImageToDataUrl(file: File, maxPx = 128): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    const url = URL.createObjectURL(file)
    img.onload = () => {
      URL.revokeObjectURL(url)
      const { naturalWidth: w, naturalHeight: h } = img
      const crop = Math.min(w, h)
      const sx = (w - crop) / 2
      const sy = (h - crop) / 2
      const canvas = document.createElement('canvas')
      canvas.width = maxPx
      canvas.height = maxPx
      canvas.getContext('2d')!.drawImage(img, sx, sy, crop, crop, 0, 0, maxPx, maxPx)
      resolve(canvas.toDataURL('image/jpeg', 0.85))
    }
    img.onerror = reject
    img.src = url
  })
}

// WCAG relative luminance (0 = black, 1 = white)
function getLuminance(hex: string): number {
  const r = parseInt(hex.slice(1, 3), 16) / 255
  const g = parseInt(hex.slice(3, 5), 16) / 255
  const b = parseInt(hex.slice(5, 7), 16) / 255
  const lin = (c: number) => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

// Build CSS variable block from colors — text/muted/bubble colors adapt to luminance
function buildThemeVars(colors: ThemeColors): string {
  const sLum = getLuminance(colors.sidebar)
  const cLum = getLuminance(colors.chat)
  const aLum = getLuminance(colors.accent)

  const sText   = sLum > 0.179 ? '#111827' : '#f9fafb'
  const sMuted  = sLum > 0.179 ? '#6b7280' : '#9ca3af'
  const cMuted  = cLum > 0.179 ? '#6b7280' : '#9ca3af'
  const aText   = aLum > 0.179 ? '#111827' : '#ffffff'
  const bubbleBg   = cLum > 0.179 ? '#e5e7eb' : '#374151'
  const bubbleText = cLum > 0.179 ? '#111827' : '#f3f4f6'

  return (
    `--sidebar-bg:${colors.sidebar};` +
    `--chat-bg:${colors.chat};` +
    `--accent:${colors.accent};` +
    `--sidebar-text:${sText};` +
    `--sidebar-muted:${sMuted};` +
    `--chat-muted:${cMuted};` +
    `--accent-text:${aText};` +
    `--msg-bubble-bg:${bubbleBg};` +
    `--msg-bubble-text:${bubbleText};`
  )
}

// ---- Icons ----
function HashIcon() {
  return (
    <svg className="w-4 h-4 shrink-0" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
      <path d="M6.5 1.5l-1 13M10.5 1.5l-1 13M2 5.5h12M1.5 10.5h12" />
    </svg>
  )
}
function PlusIcon() {
  return (
    <svg className="w-4 h-4" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <path d="M8 3v10M3 8h10" />
    </svg>
  )
}
function PencilIcon() {
  return (
    <svg className="w-3.5 h-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M11.5 2.5l2 2-8 8H3.5v-2l8-8z" />
    </svg>
  )
}
function TrashIcon() {
  return (
    <svg className="w-3.5 h-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 4h12M5 4V2h6v2M6 7v5M10 7v5M3 4l1 9h8l1-9" />
    </svg>
  )
}
function GearIcon() {
  return (
    <svg className="w-4 h-4" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="8" cy="8" r="2.5" />
      <path d="M8 1v1.5M8 13.5V15M1 8h1.5M13.5 8H15M2.93 2.93l1.06 1.06M12.01 12.01l1.06 1.06M2.93 13.07l1.06-1.06M12.01 3.99l1.06-1.06" />
    </svg>
  )
}
function CameraIcon() {
  return (
    <svg className="w-3.5 h-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M1 4h14v10H1zM5 4l1-3h4l1 3" />
      <circle cx="8" cy="9" r="2.5" />
    </svg>
  )
}
function SpinnerIcon() {
  return (
    <svg className="w-3.5 h-3.5 animate-spin" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <path d="M8 2a6 6 0 0 1 6 6" />
    </svg>
  )
}

// ---- Components ----
function Avatar({ username, avatarUrl, size = 32 }: { username: string; avatarUrl?: string | null; size?: number }) {
  if (avatarUrl) {
    return (
      <img
        src={avatarUrl}
        alt={username}
        className="rounded-full object-cover shrink-0"
        style={{ width: size, height: size }}
      />
    )
  }
  return (
    <div
      className="rounded-full flex items-center justify-center shrink-0 font-bold text-white select-none"
      style={{ width: size, height: size, backgroundColor: avatarBgColor(username), fontSize: size * 0.38 }}
    >
      {username[0]?.toUpperCase()}
    </div>
  )
}

function ChannelItem({
  channel, isActive, onClick, onRename, onDelete,
}: {
  channel: Channel; isActive: boolean
  onClick: () => void; onRename: () => void; onDelete: () => void
}) {
  const [hovered, setHovered] = useState(false)
  return (
    <div
      className={`group flex items-center gap-2 mx-2 px-2 py-1.5 rounded-md cursor-pointer transition-colors ${
        isActive ? 'theme-channel-active' : 'sidebar-channel-inactive'
      }`}
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <HashIcon />
      <span className="flex-1 text-sm truncate">{channel.name}</span>
      {hovered && (
        <div className="flex items-center gap-0.5" onClick={(e) => e.stopPropagation()}>
          <button onClick={onRename} className="sidebar-action-btn" title="名前を変更">
            <PencilIcon />
          </button>
          <button onClick={onDelete} className="sidebar-action-btn danger" title="削除">
            <TrashIcon />
          </button>
        </div>
      )}
    </div>
  )
}

function Modal({ children, title, onClose }: { children: React.ReactNode; title: string; onClose: () => void }) {
  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="bg-gray-800 rounded-xl p-6 w-full max-w-sm shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-white font-semibold text-base mb-4">{title}</h2>
        {children}
      </div>
    </div>
  )
}

function ColorRow({
  label, value, defaultValue, onChange,
}: { label: string; value: string; defaultValue: string; onChange: (v: string) => void }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-gray-300 text-sm shrink-0">{label}</span>
      <div className="flex items-center gap-2">
        <div className="relative w-7 h-7 rounded-full overflow-hidden border border-gray-600 cursor-pointer">
          <input
            type="color"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
          />
          <div className="w-full h-full pointer-events-none" style={{ backgroundColor: value }} />
        </div>
        <span className="text-gray-400 text-xs font-mono w-[4.5rem]">{value}</span>
        {value !== defaultValue && (
          <button onClick={() => onChange(defaultValue)} className="text-gray-500 hover:text-gray-300 text-xs transition-colors" title="リセット">
            ↩
          </button>
        )}
      </div>
    </div>
  )
}

function SettingsModal({
  username, myAvatarUrl, colors, onColorsChange, onAvatarUpload, onClose,
}: {
  username: string; myAvatarUrl?: string | null
  colors: ThemeColors; onColorsChange: (c: ThemeColors) => void
  onAvatarUpload: (file: File) => Promise<void>; onClose: () => void
}) {
  const [tab, setTab] = useState<'profile' | 'appearance'>('profile')
  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState('')
  const fileInputRef = useRef<HTMLInputElement>(null)

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setUploading(true)
    setUploadError('')
    try {
      await onAvatarUpload(file)
    } catch {
      setUploadError('アップロードに失敗しました')
    } finally {
      setUploading(false)
    }
  }

  return (
    <Modal onClose={onClose} title="設定">
      {/* Tabs */}
      <div className="flex gap-1 mb-5 bg-gray-700/60 rounded-lg p-1">
        {(['profile', 'appearance'] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`flex-1 py-1.5 text-sm font-medium rounded-md transition-colors ${
              tab === t ? 'bg-gray-600 text-white' : 'text-gray-400 hover:text-white'
            }`}
          >
            {t === 'profile' ? 'プロフィール' : '外観'}
          </button>
        ))}
      </div>

      {tab === 'profile' && (
        <div className="flex flex-col items-center gap-5">
          <div className="relative">
            <Avatar username={username} avatarUrl={myAvatarUrl} size={80} />
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
              className="absolute -bottom-1 -right-1 bg-gray-600 hover:bg-gray-500 text-white rounded-full p-1.5 transition-colors disabled:opacity-50"
              title="アイコンを変更"
            >
              {uploading ? <SpinnerIcon /> : <CameraIcon />}
            </button>
            <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={handleFile} />
          </div>
          <div className="text-center">
            <p className="text-white font-semibold text-base">{username}</p>
            <button
              onClick={() => fileInputRef.current?.click()}
              className="text-blue-400 hover:text-blue-300 text-sm transition-colors mt-1 block w-full"
            >
              アイコン画像をアップロード
            </button>
            {uploadError && <p className="text-red-400 text-xs mt-1">{uploadError}</p>}
            <p className="text-gray-500 text-xs mt-2">JPG / PNG / GIF（最大 5MB）</p>
          </div>
        </div>
      )}

      {tab === 'appearance' && (
        <div className="flex flex-col gap-5">
          <ColorRow
            label="サイドバーの色"
            value={colors.sidebar}
            defaultValue={DEFAULT_COLORS.sidebar}
            onChange={(v) => onColorsChange({ ...colors, sidebar: v })}
          />
          <ColorRow
            label="チャット背景色"
            value={colors.chat}
            defaultValue={DEFAULT_COLORS.chat}
            onChange={(v) => onColorsChange({ ...colors, chat: v })}
          />
          <ColorRow
            label="アクセントカラー"
            value={colors.accent}
            defaultValue={DEFAULT_COLORS.accent}
            onChange={(v) => onColorsChange({ ...colors, accent: v })}
          />
          <button
            onClick={() => onColorsChange(DEFAULT_COLORS)}
            className="mt-1 py-2 border border-gray-600 text-gray-400 hover:text-white hover:border-gray-400 text-sm rounded-lg transition-colors"
          >
            すべてデフォルトに戻す
          </button>
        </div>
      )}
    </Modal>
  )
}

// ---- Main Page ----
export default function ChatPage() {
  const [username, setUsername] = useState('')
  const [enteredName, setEnteredName] = useState(false)
  const [channels, setChannels] = useState<Channel[]>([])
  const [currentChannelId, setCurrentChannelId] = useState<number | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [userProfiles, setUserProfiles] = useState<Record<string, string | null>>({})
  const [showAddModal, setShowAddModal] = useState(false)
  const [newChannelName, setNewChannelName] = useState('')
  const [renameTarget, setRenameTarget] = useState<Channel | null>(null)
  const [renameInput, setRenameInput] = useState('')
  const [deleteTarget, setDeleteTarget] = useState<Channel | null>(null)
  const [errorMsg, setErrorMsg] = useState('')
  const [showSettings, setShowSettings] = useState(false)
  const [colors, setColors] = useState<ThemeColors>(DEFAULT_COLORS)

  const socketRef = useRef<Socket | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const currentChannelIdRef = useRef<number | null>(null)

  // Load saved settings on mount
  useEffect(() => {
    const savedName = localStorage.getItem('chat_username')
    if (savedName) { setUsername(savedName); setEnteredName(true) }
    try {
      const savedColors = localStorage.getItem('chat_colors')
      if (savedColors) setColors(JSON.parse(savedColors))
    } catch {}
  }, [])

  // Inject CSS variables for live theme updates
  useEffect(() => {
    let el = document.getElementById('chat-theme') as HTMLStyleElement | null
    if (!el) {
      el = document.createElement('style')
      el.id = 'chat-theme'
      document.head.appendChild(el)
    }
    el.textContent = `:root{${buildThemeVars(colors)}}`
  }, [colors])

  // Keep ref in sync with state
  useEffect(() => { currentChannelIdRef.current = currentChannelId }, [currentChannelId])

  // Socket connection
  useEffect(() => {
    if (!enteredName) return
    const socket = io()
    socketRef.current = socket

    socket.on('channel_list', (chs: Channel[]) => {
      setChannels(chs)
      setCurrentChannelId((prev) => {
        if (prev !== null && !chs.find((c) => c.id === prev)) {
          const first = chs[0]
          if (first) socket.emit('join_channel', first.id)
          return first?.id ?? null
        }
        return prev
      })
    })

    socket.on('history', ({ channelId, messages: msgs }: { channelId: number; messages: Message[] }) => {
      setCurrentChannelId(channelId)
      setMessages(msgs)
    })

    socket.on('new_message', (msg: Message) => {
      if (msg.channelId === currentChannelIdRef.current) {
        setMessages((prev) => [...prev, msg])
      }
    })

    socket.on('user_profiles', (profiles: Record<string, string | null>) => {
      setUserProfiles(profiles)
    })

    socket.on('channel_error', (msg: string) => setErrorMsg(msg))

    return () => { socket.disconnect() }
  }, [enteredName])

  // Scroll to bottom on new messages
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  // ---- Handlers ----
  function handleJoin(e: React.FormEvent) {
    e.preventDefault()
    const name = username.trim()
    if (!name) return
    localStorage.setItem('chat_username', name)
    setUsername(name)
    setEnteredName(true)
  }

  function handleSend(e: React.FormEvent) {
    e.preventDefault()
    if (!input.trim() || !socketRef.current || currentChannelId === null) return
    socketRef.current.emit('send_message', { username, content: input.trim(), channelId: currentChannelId })
    setInput('')
  }

  function switchChannel(id: number) {
    if (id === currentChannelId) return
    setMessages([])
    socketRef.current?.emit('join_channel', id)
  }

  function handleAddChannel(e: React.FormEvent) {
    e.preventDefault()
    if (!newChannelName.trim()) return
    setErrorMsg('')
    socketRef.current?.emit('create_channel', newChannelName.trim())
    setNewChannelName('')
    setShowAddModal(false)
  }

  function handleRename(e: React.FormEvent) {
    e.preventDefault()
    if (!renameInput.trim() || !renameTarget) return
    setErrorMsg('')
    socketRef.current?.emit('rename_channel', { id: renameTarget.id, name: renameInput.trim() })
    setRenameTarget(null)
  }

  function handleDelete() {
    if (!deleteTarget) return
    socketRef.current?.emit('delete_channel', deleteTarget.id)
    setDeleteTarget(null)
  }

  function handleColorsChange(newColors: ThemeColors) {
    setColors(newColors)
    localStorage.setItem('chat_colors', JSON.stringify(newColors))
  }

  async function handleAvatarUpload(file: File) {
    const imageData = await resizeImageToDataUrl(file)
    const res = await fetch('/api/avatar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, imageData }),
    })
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      throw new Error(data.error ?? 'Upload failed')
    }
    const data = await res.json()
    if (data.avatarUrl) {
      setUserProfiles((prev) => ({ ...prev, [username]: data.avatarUrl }))
      socketRef.current?.emit('update_profile')
    }
  }

  const currentChannel = channels.find((c) => c.id === currentChannelId)
  const myAvatarUrl = userProfiles[username]

  // ---- Login Screen ----
  if (!enteredName) {
    return (
      <div className="min-h-screen bg-gray-900 flex items-center justify-center">
        <div className="bg-gray-800 rounded-2xl p-8 w-80 shadow-2xl">
          <h1 className="text-2xl font-bold text-white mb-6 text-center">チャットへようこそ</h1>
          <form onSubmit={handleJoin} className="flex flex-col gap-4">
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="ユーザー名を入力"
              className="bg-gray-700 text-white rounded-lg px-4 py-2 outline-none focus:ring-2 focus:ring-blue-500 placeholder-gray-400"
              maxLength={20}
              autoFocus
            />
            <button type="submit" className="theme-accent-btn text-white font-semibold py-2 rounded-lg">
              参加する
            </button>
          </form>
        </div>
      </div>
    )
  }

  // ---- Chat Screen ----
  return (
    <div className="min-h-screen flex">
      {/* Sidebar */}
      <aside className="theme-sidebar w-60 flex flex-col shrink-0 border-r border-white/10">
        <div className="px-4 py-3 flex items-center justify-between border-b border-white/10">
          <span className="text-xs font-semibold uppercase tracking-wider theme-sidebar-muted">チャンネル</span>
          <button
            onClick={() => { setShowAddModal(true); setNewChannelName(''); setErrorMsg('') }}
            className="sidebar-icon-btn"
            title="チャンネルを追加"
          >
            <PlusIcon />
          </button>
        </div>

        <nav className="flex-1 overflow-y-auto py-2">
          {channels.map((ch) => (
            <ChannelItem
              key={ch.id}
              channel={ch}
              isActive={ch.id === currentChannelId}
              onClick={() => switchChannel(ch.id)}
              onRename={() => { setRenameTarget(ch); setRenameInput(ch.name); setErrorMsg('') }}
              onDelete={() => setDeleteTarget(ch)}
            />
          ))}
          {channels.length === 0 && (
            <p className="text-xs px-4 py-2 theme-sidebar-muted">チャンネルがありません</p>
          )}
        </nav>

        {/* User footer */}
        <div className="border-t border-white/10 px-3 py-2.5 flex items-center gap-2">
          <Avatar username={username} avatarUrl={myAvatarUrl} size={32} />
          <span className="flex-1 text-sm font-medium truncate">{username}</span>
          <button
            onClick={() => setShowSettings(true)}
            className="sidebar-icon-btn p-1"
            title="設定"
          >
            <GearIcon />
          </button>
        </div>
      </aside>

      {/* Chat area */}
      <div className="theme-chat-bg flex-1 flex flex-col min-w-0">
        <header className="bg-gray-800/90 backdrop-blur border-b border-white/10 px-6 py-3 flex items-center gap-2">
          {currentChannel
            ? <><HashIcon /><span className="text-white font-semibold">{currentChannel.name}</span></>
            : <span className="text-gray-400">チャンネルを選択してください</span>
          }
        </header>

        <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3">
          {currentChannel && messages.length === 0 && (
            <p className="text-center mt-10 theme-chat-muted">
              #{currentChannel.name} にメッセージがまだありません
            </p>
          )}
          {messages.map((msg) => {
            const isMe = msg.username === username
            const avatarUrl = userProfiles[msg.username]
            return (
              <div key={msg.id} className={`flex items-end gap-2 ${isMe ? 'justify-end' : 'justify-start'}`}>
                {!isMe && <Avatar username={msg.username} avatarUrl={avatarUrl} size={32} />}
                <div className={`max-w-xs lg:max-w-md flex flex-col ${isMe ? 'items-end' : 'items-start'}`}>
                  {!isMe && <span className="text-xs mb-1 ml-1 theme-chat-muted">{msg.username}</span>}
                  <div
                    className={`px-4 py-2 rounded-2xl text-sm ${
                      isMe ? 'theme-msg-self rounded-tr-none' : 'theme-msg-other rounded-tl-none'
                    }`}
                  >
                    {msg.content}
                  </div>
                  <span className="text-xs mt-1 mx-1 theme-chat-muted">
                    {new Date(msg.createdAt).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })}
                  </span>
                </div>
                {isMe && <Avatar username={msg.username} avatarUrl={myAvatarUrl} size={32} />}
              </div>
            )
          })}
          <div ref={bottomRef} />
        </div>

        <form onSubmit={handleSend} className="bg-gray-800/90 backdrop-blur border-t border-white/10 px-4 py-3 flex gap-2">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={currentChannel ? `#${currentChannel.name} にメッセージを送信` : 'チャンネルを選択してください'}
            disabled={!currentChannel}
            className="flex-1 bg-gray-700 text-white rounded-full px-4 py-2 outline-none focus:ring-2 focus:ring-blue-500 placeholder-gray-400 text-sm disabled:opacity-50"
            maxLength={500}
          />
          <button
            type="submit"
            disabled={!input.trim() || !currentChannel}
            className="theme-accent-btn text-white rounded-full px-5 py-2 font-semibold text-sm"
          >
            送信
          </button>
        </form>
      </div>

      {/* ---- Modals ---- */}
      {showAddModal && (
        <Modal onClose={() => setShowAddModal(false)} title="チャンネルを追加">
          <form onSubmit={handleAddChannel} className="flex flex-col gap-4">
            <input
              type="text"
              value={newChannelName}
              onChange={(e) => setNewChannelName(e.target.value)}
              placeholder="チャンネル名"
              className="bg-gray-700 text-white rounded-lg px-4 py-2 outline-none focus:ring-2 focus:ring-blue-500 placeholder-gray-400 text-sm"
              maxLength={50}
              autoFocus
            />
            {errorMsg && <p className="text-red-400 text-xs">{errorMsg}</p>}
            <div className="flex gap-2 justify-end">
              <button type="button" onClick={() => setShowAddModal(false)} className="px-4 py-2 text-sm text-gray-400 hover:text-white transition-colors">
                キャンセル
              </button>
              <button type="submit" disabled={!newChannelName.trim()} className="theme-accent-btn text-white px-4 py-2 rounded-lg text-sm font-semibold">
                追加
              </button>
            </div>
          </form>
        </Modal>
      )}

      {renameTarget && (
        <Modal onClose={() => setRenameTarget(null)} title="チャンネル名を変更">
          <form onSubmit={handleRename} className="flex flex-col gap-4">
            <input
              type="text"
              value={renameInput}
              onChange={(e) => setRenameInput(e.target.value)}
              className="bg-gray-700 text-white rounded-lg px-4 py-2 outline-none focus:ring-2 focus:ring-blue-500 text-sm"
              maxLength={50}
              autoFocus
            />
            {errorMsg && <p className="text-red-400 text-xs">{errorMsg}</p>}
            <div className="flex gap-2 justify-end">
              <button type="button" onClick={() => setRenameTarget(null)} className="px-4 py-2 text-sm text-gray-400 hover:text-white transition-colors">
                キャンセル
              </button>
              <button type="submit" disabled={!renameInput.trim() || renameInput === renameTarget.name} className="theme-accent-btn text-white px-4 py-2 rounded-lg text-sm font-semibold">
                変更
              </button>
            </div>
          </form>
        </Modal>
      )}

      {deleteTarget && (
        <Modal onClose={() => setDeleteTarget(null)} title="チャンネルを削除">
          <p className="text-gray-300 text-sm mb-4">
            <span className="text-white font-semibold">#{deleteTarget.name}</span> を削除しますか？
            <br />このチャンネルのメッセージもすべて削除されます。
          </p>
          <div className="flex gap-2 justify-end">
            <button onClick={() => setDeleteTarget(null)} className="px-4 py-2 text-sm text-gray-400 hover:text-white transition-colors">
              キャンセル
            </button>
            <button onClick={handleDelete} className="bg-red-600 hover:bg-red-500 text-white px-4 py-2 rounded-lg text-sm font-semibold transition-colors">
              削除する
            </button>
          </div>
        </Modal>
      )}

      {showSettings && (
        <SettingsModal
          username={username}
          myAvatarUrl={myAvatarUrl}
          colors={colors}
          onColorsChange={handleColorsChange}
          onAvatarUpload={handleAvatarUpload}
          onClose={() => setShowSettings(false)}
        />
      )}
    </div>
  )
}

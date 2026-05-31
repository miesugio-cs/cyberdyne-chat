'use client'

import { useEffect, useRef, useState } from 'react'
import { io, Socket } from 'socket.io-client'

// ---- Types ----
interface Channel {
  id: number; name: string; isPrivate: boolean
  members: { username: string }[]; createdAt: string
}
interface Message {
  id: number; username: string; content: string; channelId: number
  attachmentData: string | null; attachmentName: string | null; attachmentType: string | null
  createdAt: string; parentId: number | null; replyCount: number
}
interface UserProfileData { avatarUrl: string | null; email: string | null; title: string | null }
interface Attachment { data: string; name: string; type: string }
interface ThemeColors { sidebar: string; chat: string; accent: string }
interface MeetingStatus { inMeeting: boolean; eventTitle: string; endTime: string }
interface NotifSettings {
  enabled: boolean; sound: boolean; soundType: string; badge: boolean; trigger: 'mention' | 'all'
}

// ---- Constants ----
const DEFAULT_COLORS: ThemeColors = { sidebar: '#1f2937', chat: '#111827', accent: '#2563eb' }
const DEFAULT_NOTIF: NotifSettings = { enabled: true, sound: true, soundType: 'pop', badge: true, trigger: 'mention' }
const SOUNDS = [
  { key: 'pop',    label: 'ポップ' },
  { key: 'chime',  label: 'チャイム' },
  { key: 'beep',   label: 'ビープ' },
  { key: 'ding',   label: 'ティーン' },
  { key: 'gentle', label: 'やさしい' },
]

// ---- Utilities ----
function avatarBgColor(username: string): string {
  const palette = ['#e74c3c','#e67e22','#f39c12','#2ecc71','#1abc9c','#3498db','#9b59b6','#e91e63','#00bcd4','#ff5722']
  let h = 0; for (const c of username) h = (h * 31 + c.charCodeAt(0)) | 0
  return palette[Math.abs(h) % palette.length]
}
function getLuminance(hex: string): number {
  const r = parseInt(hex.slice(1,3),16)/255, g = parseInt(hex.slice(3,5),16)/255, b = parseInt(hex.slice(5,7),16)/255
  const lin = (c: number) => c <= 0.04045 ? c/12.92 : ((c+0.055)/1.055)**2.4
  return 0.2126*lin(r) + 0.7152*lin(g) + 0.0722*lin(b)
}
function buildThemeVars(colors: ThemeColors): string {
  const sL = getLuminance(colors.sidebar), cL = getLuminance(colors.chat), aL = getLuminance(colors.accent)
  return `--sidebar-bg:${colors.sidebar};--chat-bg:${colors.chat};--accent:${colors.accent};`+
    `--sidebar-text:${sL>0.179?'#111827':'#f9fafb'};--sidebar-muted:${sL>0.179?'#6b7280':'#9ca3af'};`+
    `--chat-muted:${cL>0.179?'#6b7280':'#9ca3af'};--accent-text:${aL>0.179?'#111827':'#ffffff'};`+
    `--msg-bubble-bg:${cL>0.179?'#e5e7eb':'#374151'};--msg-bubble-text:${cL>0.179?'#111827':'#f3f4f6'};`
}
function formatTime(iso: string): string {
  if (!iso) return ''
  return new Date(iso).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })
}
function resizeImageToDataUrl(file: File, maxPx = 128): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image(), url = URL.createObjectURL(file)
    img.onload = () => {
      URL.revokeObjectURL(url)
      const { naturalWidth: w, naturalHeight: h } = img
      const crop = Math.min(w,h), sx = (w-crop)/2, sy = (h-crop)/2
      const canvas = document.createElement('canvas'); canvas.width = maxPx; canvas.height = maxPx
      canvas.getContext('2d')!.drawImage(img, sx, sy, crop, crop, 0, 0, maxPx, maxPx)
      resolve(canvas.toDataURL('image/jpeg', 0.85))
    }
    img.onerror = reject; img.src = url
  })
}
function resizeAttachmentImage(file: File, maxPx = 1200): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image(), url = URL.createObjectURL(file)
    img.onload = () => {
      URL.revokeObjectURL(url)
      const { naturalWidth: w, naturalHeight: h } = img
      const scale = Math.min(1, maxPx/Math.max(w,h))
      const canvas = document.createElement('canvas')
      canvas.width = Math.round(w*scale); canvas.height = Math.round(h*scale)
      canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height)
      resolve(canvas.toDataURL('image/jpeg', 0.80))
    }
    img.onerror = reject; img.src = url
  })
}
function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = reject; reader.readAsDataURL(file)
  })
}
function renderWithMentions(content: string, currentUsername: string): React.ReactNode {
  return content.split(/(@\w+)/g).map((part, i) => {
    if (/^@\w+$/.test(part)) {
      const isMe = part === `@${currentUsername}`
      return <span key={i} className={`font-semibold ${isMe ? 'bg-yellow-400/20 text-yellow-300 px-0.5 rounded' : 'text-blue-400'}`}>{part}</span>
    }
    return part
  })
}
function playNotifSound(type: string) {
  try {
    const ctx = new (window.AudioContext || (window as any).webkitAudioContext)()
    const osc = ctx.createOscillator(), gain = ctx.createGain()
    osc.connect(gain); gain.connect(ctx.destination)
    const t = ctx.currentTime
    switch (type) {
      case 'pop':
        osc.type = 'sine'; osc.frequency.value = 880
        gain.gain.setValueAtTime(0.45, t); gain.gain.exponentialRampToValueAtTime(0.001, t + 0.35)
        osc.start(t); osc.stop(t + 0.35); break
      case 'chime':
        osc.type = 'sine'; osc.frequency.value = 1047
        gain.gain.setValueAtTime(0.4, t); gain.gain.exponentialRampToValueAtTime(0.001, t + 1.5)
        osc.start(t); osc.stop(t + 1.5); break
      case 'beep':
        osc.type = 'square'; osc.frequency.value = 440
        gain.gain.setValueAtTime(0.15, t); gain.gain.setValueAtTime(0.15, t + 0.25); gain.gain.exponentialRampToValueAtTime(0.001, t + 0.4)
        osc.start(t); osc.stop(t + 0.4); break
      case 'ding':
        osc.type = 'sine'; osc.frequency.value = 1500
        gain.gain.setValueAtTime(0.35, t); gain.gain.exponentialRampToValueAtTime(0.001, t + 0.9)
        osc.start(t); osc.stop(t + 0.9); break
      case 'gentle':
        osc.type = 'sine'; osc.frequency.value = 523
        gain.gain.setValueAtTime(0, t); gain.gain.linearRampToValueAtTime(0.28, t + 0.08)
        gain.gain.exponentialRampToValueAtTime(0.001, t + 2.0)
        osc.start(t); osc.stop(t + 2.0); break
    }
    setTimeout(() => ctx.close(), 2500)
  } catch {}
}

// ---- Icons ----
function HashIcon()     { return <svg className="w-4 h-4 shrink-0" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><path d="M6.5 1.5l-1 13M10.5 1.5l-1 13M2 5.5h12M1.5 10.5h12"/></svg> }
function LockIcon()     { return <svg className="w-3.5 h-3.5 shrink-0" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="7" width="10" height="8" rx="1"/><path d="M5 7V5a3 3 0 0 1 6 0v2"/></svg> }
function PlusIcon()     { return <svg className="w-4 h-4" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M8 3v10M3 8h10"/></svg> }
function PencilIcon()   { return <svg className="w-3.5 h-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M11.5 2.5l2 2-8 8H3.5v-2l8-8z"/></svg> }
function TrashIcon()    { return <svg className="w-3.5 h-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M2 4h12M5 4V2h6v2M6 7v5M10 7v5M3 4l1 9h8l1-9"/></svg> }
function InviteIcon()   { return <svg className="w-3.5 h-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="6" cy="5" r="2.5"/><path d="M1 14c0-3 2-4.5 5-4.5s5 1.5 5 4.5"/><path d="M13 8v4M11 10h4"/></svg> }
function GearIcon()     { return <svg className="w-4 h-4" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="8" cy="8" r="2.5"/><path d="M8 1v1.5M8 13.5V15M1 8h1.5M13.5 8H15M2.93 2.93l1.06 1.06M12.01 12.01l1.06 1.06M2.93 13.07l1.06-1.06M12.01 3.99l1.06-1.06"/></svg> }
function CameraIcon()   { return <svg className="w-3.5 h-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M1 4h14v10H1zM5 4l1-3h4l1 3"/><circle cx="8" cy="9" r="2.5"/></svg> }
function SpinnerIcon()  { return <svg className="w-3.5 h-3.5 animate-spin" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M8 2a6 6 0 0 1 6 6"/></svg> }
function PaperclipIcon({ className }: { className?: string }) { return <svg className={`w-4 h-4 ${className??''}`} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M13 7.5l-6 6a3.5 3.5 0 0 1-5-5l7-7a2 2 0 0 1 3 3l-7 7a.5.5 0 0 1-1-1l6-6"/></svg> }
function XIcon()        { return <svg className="w-4 h-4" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M3 3l10 10M13 3L3 13"/></svg> }
function FileIcon()     { return <svg className="w-4 h-4 shrink-0" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M9 1H3a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V6L9 1z"/><path d="M9 1v5h5"/></svg> }
function PeopleIcon()   { return <svg className="w-4 h-4" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="6" cy="5" r="2.5"/><path d="M1 14c0-3 2-4.5 5-4.5s5 1.5 5 4.5"/><circle cx="12" cy="5" r="2"/><path d="M15 13.5c0-2-1.5-3-3-3"/></svg> }
function BellIcon()     { return <svg className="w-4 h-4" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M8 1.5A4.5 4.5 0 0 1 12.5 6v3l1 2h-11l1-2V6A4.5 4.5 0 0 1 8 1.5z"/><path d="M6.5 13.5a1.5 1.5 0 0 0 3 0"/></svg> }
function ReplyIcon()    { return <svg className="w-3.5 h-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M2 6h8a4 4 0 0 1 0 8H8"/><path d="M4 4L2 6l2 2"/></svg> }

// ---- Base components ----
function Avatar({ username, avatarUrl, size = 32 }: { username: string; avatarUrl?: string | null; size?: number }) {
  if (avatarUrl) return <img src={avatarUrl} alt={username} className="rounded-full object-cover shrink-0" style={{ width: size, height: size }} />
  return <div className="rounded-full flex items-center justify-center shrink-0 font-bold text-white select-none" style={{ width: size, height: size, backgroundColor: avatarBgColor(username), fontSize: size*0.38 }}>{username[0]?.toUpperCase()}</div>
}

function Modal({ children, title, onClose }: { children: React.ReactNode; title: string; onClose: () => void }) {
  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="bg-gray-800 rounded-xl p-6 w-full max-w-sm shadow-2xl" onClick={e => e.stopPropagation()}>
        {title && <h2 className="text-white font-semibold text-base mb-4">{title}</h2>}
        {children}
      </div>
    </div>
  )
}

// ---- Profile Card ----
function ProfileCard({ username, profile, status, onClose }: {
  username: string; profile: UserProfileData | undefined
  status: MeetingStatus | undefined; onClose: () => void
}) {
  return (
    <Modal onClose={onClose} title="">
      <div className="flex flex-col items-center gap-4">
        <Avatar username={username} avatarUrl={profile?.avatarUrl} size={80} />
        <div className="text-center">
          <p className="text-white font-bold text-xl">{username}</p>
          {profile?.title && <p className="text-gray-300 text-sm mt-0.5">{profile.title}</p>}
          {profile?.email && <p className="text-gray-400 text-xs mt-1">{profile.email}</p>}
        </div>
        {status !== undefined ? (
          status.inMeeting ? (
            <div className="w-full bg-blue-500/10 border border-blue-500/30 rounded-xl px-4 py-3">
              <p className="text-blue-400 text-sm font-medium">🗓️ In a meeting ～{formatTime(status.endTime)}</p>
              {status.eventTitle && <p className="text-gray-300 text-xs mt-1">{status.eventTitle}</p>}
            </div>
          ) : (
            <div className="w-full bg-green-500/10 border border-green-500/20 rounded-xl px-4 py-3">
              <p className="text-green-400 text-sm">✓ 対応可能</p>
            </div>
          )
        ) : null}
      </div>
    </Modal>
  )
}

// ---- Toggle ----
function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button onClick={() => onChange(!checked)} className={`relative w-10 h-5 rounded-full transition-colors ${checked ? 'bg-blue-500' : 'bg-gray-600'}`}>
      <span className={`absolute top-0.5 w-4 h-4 bg-white rounded-full transition-transform shadow-sm ${checked ? 'translate-x-5' : 'translate-x-0.5'}`} />
    </button>
  )
}

// ---- Members Panel ----
function MembersPanel({ channel, onlineUsers, allUsers, userProfiles, userStatuses, onAvatarClick }: {
  channel: Channel | undefined
  onlineUsers: string[]
  allUsers: string[]
  userProfiles: Record<string, UserProfileData>
  userStatuses: Record<string, MeetingStatus>
  onAvatarClick: (username: string) => void
}) {
  const onlineSet = new Set(onlineUsers)
  const members = channel?.isPrivate
    ? channel.members.map(m => ({ username: m.username, online: onlineSet.has(m.username) }))
    : [...new Set([...onlineUsers, ...allUsers])].map(u => ({ username: u, online: onlineSet.has(u) }))
  const sorted = [...members].sort((a, b) => {
    if (a.online !== b.online) return a.online ? -1 : 1
    return a.username.localeCompare(b.username)
  })
  return (
    <aside className="theme-sidebar w-48 shrink-0 border-l border-white/10 flex flex-col">
      <div className="px-3 py-3 border-b border-white/10 flex items-center gap-2">
        <span className="text-xs font-semibold uppercase tracking-wider theme-sidebar-muted flex-1">メンバー</span>
        <span className="text-xs theme-sidebar-muted">{members.length}</span>
      </div>
      <div className="flex-1 overflow-y-auto py-2 space-y-0.5">
        {sorted.map(({ username, online }) => {
          const profile = userProfiles[username]
          const status  = userStatuses[username]
          return (
            <div key={username} className="flex items-center gap-2 px-3 py-1.5">
              <div className="relative shrink-0">
                <button onClick={() => onAvatarClick(username)} className="block rounded-full focus:outline-none">
                  <Avatar username={username} avatarUrl={profile?.avatarUrl} size={28} />
                </button>
                <span className={`absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full border-2 border-gray-900 ${online ? 'bg-green-400' : 'bg-gray-500'}`} />
                {status?.inMeeting && <span className="absolute -top-1 -right-1 text-xs leading-none pointer-events-none">🗓️</span>}
              </div>
              <div className="min-w-0 flex-1">
                <p className={`text-xs font-medium truncate ${online ? '' : 'opacity-50'}`}>{username}</p>
                {status?.inMeeting && <p className="text-xs text-blue-400 truncate">～{formatTime(status.endTime)}</p>}
              </div>
            </div>
          )
        })}
        {sorted.length === 0 && <p className="text-xs px-3 py-2 theme-sidebar-muted">メンバーなし</p>}
      </div>
    </aside>
  )
}

// ---- Channel list item ----
function ChannelItem({ channel, isActive, onClick, onRename, onDelete, onInvite }: {
  channel: Channel; isActive: boolean
  onClick: () => void; onRename: () => void; onDelete: () => void; onInvite: () => void
}) {
  const [hovered, setHovered] = useState(false)
  return (
    <div
      className={`group flex items-center gap-2 mx-2 px-2 py-1.5 rounded-md cursor-pointer transition-colors ${isActive ? 'theme-channel-active' : 'sidebar-channel-inactive'}`}
      onClick={onClick} onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}
    >
      {channel.isPrivate ? <LockIcon /> : <HashIcon />}
      <span className="flex-1 text-sm truncate">{channel.name}</span>
      {hovered && (
        <div className="flex items-center gap-0.5" onClick={e => e.stopPropagation()}>
          {channel.isPrivate && <button onClick={onInvite} className="sidebar-action-btn" title="メンバーを招待"><InviteIcon /></button>}
          <button onClick={onRename} className="sidebar-action-btn" title="名前を変更"><PencilIcon /></button>
          <button onClick={onDelete} className="sidebar-action-btn danger" title="削除"><TrashIcon /></button>
        </div>
      )}
    </div>
  )
}

// ---- Color picker row ----
function ColorRow({ label, value, defaultValue, onChange }: { label: string; value: string; defaultValue: string; onChange: (v: string) => void }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-gray-300 text-sm shrink-0">{label}</span>
      <div className="flex items-center gap-2">
        <div className="relative w-7 h-7 rounded-full overflow-hidden border border-gray-600 cursor-pointer">
          <input type="color" value={value} onChange={e => onChange(e.target.value)} className="absolute inset-0 w-full h-full opacity-0 cursor-pointer" />
          <div className="w-full h-full pointer-events-none" style={{ backgroundColor: value }} />
        </div>
        <span className="text-gray-400 text-xs font-mono w-[4.5rem]">{value}</span>
        {value !== defaultValue && <button onClick={() => onChange(defaultValue)} className="text-gray-500 hover:text-gray-300 text-xs transition-colors" title="リセット">↩</button>}
      </div>
    </div>
  )
}

// ---- Settings Modal ----
function SettingsModal({ username, myProfile, colors, onColorsChange, onAvatarUpload, onSaveProfileDetails, notifSettings, onNotifSettingsChange, onClose }: {
  username: string; myProfile: UserProfileData | undefined
  colors: ThemeColors; onColorsChange: (c: ThemeColors) => void
  onAvatarUpload: (file: File) => Promise<void>
  onSaveProfileDetails: (email: string, title: string) => void
  notifSettings: NotifSettings; onNotifSettingsChange: (s: NotifSettings) => void
  onClose: () => void
}) {
  const [tab, setTab]             = useState<'profile' | 'appearance' | 'integrations' | 'notifications'>('profile')
  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState('')
  const [titleInput, setTitleInput] = useState('')
  const [emailInput, setEmailInput] = useState('')
  const [saved, setSaved]           = useState(false)
  const [calConnected, setCalConnected] = useState<boolean | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (tab !== 'profile') return
    setTitleInput(myProfile?.title ?? '')
    setEmailInput(myProfile?.email ?? '')
  }, [tab, myProfile])

  useEffect(() => {
    if (tab !== 'integrations') return
    fetch(`/api/auth/google/status?username=${encodeURIComponent(username)}`)
      .then(r => r.json()).then(d => setCalConnected(d.connected)).catch(() => setCalConnected(false))
  }, [tab, username])

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]; if (!file) return
    setUploading(true); setUploadError('')
    try { await onAvatarUpload(file) } catch { setUploadError('アップロードに失敗しました') }
    finally { setUploading(false) }
  }

  function handleSave() {
    onSaveProfileDetails(emailInput.trim(), titleInput.trim())
    setSaved(true); setTimeout(() => setSaved(false), 2000)
  }

  async function handleDisconnect() {
    await fetch('/api/auth/google/disconnect', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username }) })
    setCalConnected(false)
  }

  const TABS = [{ key: 'profile', label: 'プロフィール' }, { key: 'appearance', label: '外観' }, { key: 'notifications', label: '通知' }, { key: 'integrations', label: '連携' }] as const
  return (
    <Modal onClose={onClose} title="">
      <div className="flex gap-1 mb-5 bg-gray-700/60 rounded-lg p-1">
        {TABS.map(t => (
          <button key={t.key} onClick={() => setTab(t.key)} className={`flex-1 py-1.5 text-sm font-medium rounded-md transition-colors ${tab===t.key?'bg-gray-600 text-white':'text-gray-400 hover:text-white'}`}>{t.label}</button>
        ))}
      </div>

      {tab === 'profile' && (
        <div className="flex flex-col gap-5">
          {/* Avatar */}
          <div className="flex flex-col items-center gap-3">
            <div className="relative">
              <Avatar username={username} avatarUrl={myProfile?.avatarUrl} size={72} />
              <button onClick={() => fileInputRef.current?.click()} disabled={uploading} className="absolute -bottom-1 -right-1 bg-gray-600 hover:bg-gray-500 text-white rounded-full p-1.5 transition-colors disabled:opacity-50" title="アイコンを変更">
                {uploading ? <SpinnerIcon /> : <CameraIcon />}
              </button>
              <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={handleFile} />
            </div>
            <p className="text-white font-semibold">{username}</p>
            {uploadError && <p className="text-red-400 text-xs">{uploadError}</p>}
          </div>
          {/* Profile details */}
          <div className="flex flex-col gap-3">
            <div>
              <label className="text-gray-400 text-xs mb-1 block">肩書き</label>
              <input type="text" value={titleInput} onChange={e => setTitleInput(e.target.value)} placeholder="例: フロントエンドエンジニア" className="w-full bg-gray-700 text-white rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500 placeholder-gray-500" maxLength={50} />
            </div>
            <div>
              <label className="text-gray-400 text-xs mb-1 block">メールアドレス</label>
              <input type="email" value={emailInput} onChange={e => setEmailInput(e.target.value)} placeholder="you@example.com" className="w-full bg-gray-700 text-white rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500 placeholder-gray-500" maxLength={100} />
            </div>
            <button onClick={handleSave} className="theme-accent-btn text-white py-2 rounded-lg text-sm font-semibold">
              {saved ? '✓ 保存しました' : '保存'}
            </button>
          </div>
        </div>
      )}

      {tab === 'appearance' && (
        <div className="flex flex-col gap-5">
          <ColorRow label="サイドバーの色" value={colors.sidebar} defaultValue={DEFAULT_COLORS.sidebar} onChange={v => onColorsChange({...colors,sidebar:v})} />
          <ColorRow label="チャット背景色" value={colors.chat} defaultValue={DEFAULT_COLORS.chat} onChange={v => onColorsChange({...colors,chat:v})} />
          <ColorRow label="アクセントカラー" value={colors.accent} defaultValue={DEFAULT_COLORS.accent} onChange={v => onColorsChange({...colors,accent:v})} />
          <button onClick={() => onColorsChange(DEFAULT_COLORS)} className="mt-1 py-2 border border-gray-600 text-gray-400 hover:text-white hover:border-gray-400 text-sm rounded-lg transition-colors">すべてデフォルトに戻す</button>
        </div>
      )}

      {tab === 'notifications' && (
        <div className="flex flex-col gap-4">
          {/* Master toggle */}
          <div className="flex items-center justify-between">
            <div>
              <p className="text-gray-200 text-sm font-medium">ブラウザ通知</p>
              <p className="text-gray-500 text-xs mt-0.5">タブがバックグラウンドのときに通知</p>
            </div>
            <Toggle checked={notifSettings.enabled} onChange={v => {
              if (v && typeof Notification !== 'undefined' && Notification.permission === 'default') Notification.requestPermission()
              onNotifSettingsChange({...notifSettings, enabled: v})
            }} />
          </div>
          {/* Trigger */}
          <div className="flex flex-col gap-2">
            <p className="text-gray-400 text-xs font-medium">通知タイミング</p>
            <div className="flex gap-2">
              {([{key:'mention',label:'メンション時のみ'},{key:'all',label:'全メッセージ'}] as const).map(opt => (
                <button key={opt.key} onClick={() => onNotifSettingsChange({...notifSettings, trigger: opt.key})}
                  className={`flex-1 py-2 text-xs rounded-lg border transition-colors ${notifSettings.trigger===opt.key?'border-blue-500 text-blue-400 bg-blue-500/10':'border-gray-600 text-gray-400 hover:border-gray-400'}`}>
                  {opt.label}
                </button>
              ))}
            </div>
          </div>
          {/* Sound toggle */}
          <div className="flex items-center justify-between">
            <p className="text-gray-200 text-sm font-medium">通知音</p>
            <Toggle checked={notifSettings.sound} onChange={v => onNotifSettingsChange({...notifSettings, sound: v})} />
          </div>
          {notifSettings.sound && (
            <div className="flex flex-col gap-2">
              <p className="text-gray-400 text-xs font-medium">通知音の種類</p>
              <div className="grid grid-cols-3 gap-1.5">
                {SOUNDS.map(s => (
                  <button key={s.key} onClick={() => onNotifSettingsChange({...notifSettings, soundType: s.key})}
                    className={`py-1.5 text-xs rounded-lg border transition-colors ${notifSettings.soundType===s.key?'border-blue-500 text-blue-400 bg-blue-500/10':'border-gray-600 text-gray-400 hover:border-gray-400'}`}>
                    {s.label}
                  </button>
                ))}
              </div>
              <button onClick={() => playNotifSound(notifSettings.soundType)}
                className="text-xs text-gray-400 hover:text-white py-1 border border-gray-600 hover:border-gray-400 rounded-lg transition-colors">
                ▶ テスト再生
              </button>
            </div>
          )}
          {/* Badge toggle */}
          <div className="flex items-center justify-between">
            <div>
              <p className="text-gray-200 text-sm font-medium">未読バッジ</p>
              <p className="text-gray-500 text-xs mt-0.5">タブタイトルに未読件数を表示</p>
            </div>
            <Toggle checked={notifSettings.badge} onChange={v => onNotifSettingsChange({...notifSettings, badge: v})} />
          </div>
        </div>
      )}

      {tab === 'integrations' && (
        <div className="flex flex-col gap-4">
          <div className="bg-gray-700/50 rounded-xl p-4">
            <div className="flex items-center gap-3 mb-4">
              <span className="text-2xl">🗓️</span>
              <div>
                <p className="text-white font-medium text-sm">Google Calendar</p>
                <p className="text-gray-400 text-xs">ミーティング中のステータスを自動表示（5分ごと更新）</p>
              </div>
            </div>
            {calConnected === null && <p className="text-gray-400 text-sm">確認中...</p>}
            {calConnected === true && (
              <div className="flex items-center justify-between">
                <span className="text-green-400 text-sm">✓ 連携済み</span>
                <button onClick={handleDisconnect} className="text-red-400 hover:text-red-300 text-sm transition-colors">連携を解除</button>
              </div>
            )}
            {calConnected === false && (
              <a href={`/api/auth/google?username=${encodeURIComponent(username)}`} className="block w-full text-center theme-accent-btn py-2 rounded-lg text-sm font-semibold">
                Google アカウントで連携
              </a>
            )}
          </div>
          <p className="text-gray-500 text-xs">環境変数 GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REDIRECT_URI が必要です。</p>
        </div>
      )}
    </Modal>
  )
}

// ---- Mention popup ----
function MentionPopup({ candidates, selectedIndex, onSelect }: {
  candidates: string[]; selectedIndex: number; onSelect: (u: string) => void
}) {
  return (
    <div className="absolute bottom-full left-0 mb-2 w-52 bg-gray-800 border border-gray-700 rounded-xl shadow-2xl overflow-hidden z-50">
      {candidates.map((u, i) => (
        <button key={u} type="button"
          onMouseDown={e => { e.preventDefault(); onSelect(u) }}
          className={`w-full text-left px-3 py-2 text-sm flex items-center gap-2 transition-colors ${i === selectedIndex ? 'bg-blue-500/20 text-white' : 'text-gray-200 hover:bg-gray-700/60'}`}>
          <span className="text-blue-400 font-semibold shrink-0">@</span>
          <span className="truncate">{u}</span>
        </button>
      ))}
    </div>
  )
}

// ---- Mention-aware text input ----
function MentionInput({ value, onChange, onSubmit, placeholder, disabled, maxLength, className, allUsers }: {
  value: string; onChange: (v: string) => void; onSubmit: () => void
  placeholder?: string; disabled?: boolean; maxLength?: number; className?: string; allUsers: string[]
}) {
  const [mentionQuery, setMentionQuery] = useState<string | null>(null)
  const [mentionIndex, setMentionIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  const candidates = mentionQuery !== null
    ? allUsers.filter(u => u.toLowerCase().startsWith(mentionQuery.toLowerCase())).slice(0, 8)
    : []

  function detectMention(val: string, cursorPos: number) {
    const before = val.slice(0, cursorPos)
    const match = before.match(/(^|\s)@(\w*)$/)
    if (match) { setMentionQuery(match[2]); setMentionIndex(0) }
    else setMentionQuery(null)
  }

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    onChange(e.target.value)
    detectMention(e.target.value, e.target.selectionStart ?? e.target.value.length)
  }

  function selectMention(username: string) {
    const input = inputRef.current!
    const pos = input.selectionStart ?? value.length
    const before = value.slice(0, pos)
    const after = value.slice(pos)
    const newBefore = before.replace(/(^|\s)@\w*$/, (m, space) => `${space}@${username} `)
    onChange(newBefore + after)
    setMentionQuery(null)
    requestAnimationFrame(() => { input.focus(); input.setSelectionRange(newBefore.length, newBefore.length) })
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.nativeEvent.isComposing) return
    if (mentionQuery !== null && candidates.length > 0) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setMentionIndex(i => Math.min(i + 1, candidates.length - 1)); return }
      if (e.key === 'ArrowUp')   { e.preventDefault(); setMentionIndex(i => Math.max(i - 1, 0)); return }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); selectMention(candidates[mentionIndex]); return }
      if (e.key === 'Escape') { e.preventDefault(); setMentionQuery(null); return }
    }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onSubmit() }
  }

  return (
    <div className="relative flex-1">
      <input ref={inputRef} type="text" value={value} onChange={handleChange} onKeyDown={handleKeyDown}
        onBlur={() => setTimeout(() => setMentionQuery(null), 150)}
        placeholder={placeholder} disabled={disabled} className={className} maxLength={maxLength} />
      {mentionQuery !== null && candidates.length > 0 && (
        <MentionPopup candidates={candidates} selectedIndex={mentionIndex} onSelect={selectMention} />
      )}
    </div>
  )
}

// ---- Thread message row (always left-aligned in thread panel) ----
function ThreadMessageRow({ msg, userProfiles, onAvatarClick, isParent = false, currentUsername }: {
  msg: Message; userProfiles: Record<string, UserProfileData>
  onAvatarClick: (username: string) => void; isParent?: boolean; currentUsername: string
}) {
  const avatarUrl = userProfiles[msg.username]?.avatarUrl
  return (
    <div className={`flex items-start gap-2 ${isParent ? 'pb-2' : ''}`}>
      <button onClick={() => onAvatarClick(msg.username)} className="block rounded-full shrink-0 focus:outline-none mt-0.5">
        <Avatar username={msg.username} avatarUrl={avatarUrl} size={28} />
      </button>
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2 mb-1">
          <button onClick={() => onAvatarClick(msg.username)} className="text-sm font-medium hover:underline focus:outline-none">{msg.username}</button>
          <span className="text-xs theme-chat-muted">{formatTime(msg.createdAt)}</span>
        </div>
        {msg.content && (
          <div className={`px-3 py-2 rounded-2xl rounded-tl-none text-sm theme-msg-other inline-block max-w-full ${isParent ? 'opacity-90' : ''}`}>
            {renderWithMentions(msg.content, currentUsername)}
          </div>
        )}
        {msg.attachmentData && (
          <div className="mt-1">
            {msg.attachmentType?.startsWith('image/') ? (
              <img src={msg.attachmentData} alt={msg.attachmentName ?? 'image'} className="max-w-[200px] max-h-40 rounded-xl object-contain" loading="lazy" />
            ) : (
              <a href={msg.attachmentData} download={msg.attachmentName} className="flex items-center gap-2 bg-gray-700/70 px-3 py-2 rounded-xl text-sm text-gray-300 max-w-xs">
                <FileIcon /><span className="truncate">{msg.attachmentName}</span>
              </a>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

// ---- Thread Panel ----
function ThreadPanel({ parentMessage, replies, userProfiles, threadInput, onInputChange, onSend, onClose, onAvatarClick, allUsers, currentUsername }: {
  parentMessage: Message; replies: Message[]
  userProfiles: Record<string, UserProfileData>
  threadInput: string; onInputChange: (v: string) => void
  onSend: () => void; onClose: () => void
  onAvatarClick: (username: string) => void
  allUsers: string[]; currentUsername: string
}) {
  const threadBottomRef = useRef<HTMLDivElement>(null)
  useEffect(() => { threadBottomRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [replies])
  return (
    <aside className="theme-chat-bg w-80 shrink-0 border-l border-white/10 flex flex-col">
      <div className="px-4 py-3 border-b border-white/10 flex items-center">
        <span className="text-white font-semibold flex-1">スレッド</span>
        <button onClick={onClose} className="text-gray-400 hover:text-white transition-colors p-1 rounded-md hover:bg-gray-700/50"><XIcon /></button>
      </div>
      <div className="flex-1 overflow-y-auto px-3 py-3">
        <ThreadMessageRow msg={parentMessage} userProfiles={userProfiles} onAvatarClick={onAvatarClick} isParent currentUsername={currentUsername} />
        <div className="flex items-center gap-2 my-3">
          <div className="flex-1 h-px bg-white/10" />
          <span className="text-xs theme-chat-muted shrink-0">
            {replies.length > 0 ? `${replies.length}件の返信` : '返信はまだありません'}
          </span>
          <div className="flex-1 h-px bg-white/10" />
        </div>
        <div className="space-y-3">
          {replies.map(reply => (
            <ThreadMessageRow key={reply.id} msg={reply} userProfiles={userProfiles} onAvatarClick={onAvatarClick} currentUsername={currentUsername} />
          ))}
        </div>
        <div ref={threadBottomRef} />
      </div>
      <form onSubmit={e => { e.preventDefault(); onSend() }} className="bg-gray-800/90 border-t border-white/10 px-3 py-2.5">
        <div className="flex gap-2">
          <MentionInput
            value={threadInput} onChange={onInputChange} onSubmit={onSend}
            placeholder="スレッドに返信..."
            className="flex-1 bg-gray-700 text-white rounded-full px-3 py-1.5 text-sm outline-none focus:ring-2 focus:ring-blue-500 placeholder-gray-400"
            maxLength={500} allUsers={allUsers}
          />
          <button type="submit" disabled={!threadInput.trim()} className="theme-accent-btn text-white rounded-full px-3 py-1.5 text-sm font-semibold">送信</button>
        </div>
      </form>
    </aside>
  )
}

// ---- Main Page ----
export default function ChatPage() {
  const [username, setUsername]         = useState('')
  const [enteredName, setEnteredName]   = useState(false)
  const [channels, setChannels]         = useState<Channel[]>([])
  const [currentChannelId, setCurrentChannelId] = useState<number | null>(null)
  const [messages, setMessages]         = useState<Message[]>([])
  const [input, setInput]               = useState('')
  const [attachment, setAttachment]     = useState<Attachment | null>(null)
  const [attachmentLoading, setAttachmentLoading] = useState(false)
  const [userProfiles, setUserProfiles] = useState<Record<string, UserProfileData>>({})
  const [userStatuses, setUserStatuses] = useState<Record<string, MeetingStatus>>({})
  const [showSettings, setShowSettings] = useState(false)
  const [colors, setColors]             = useState<ThemeColors>(DEFAULT_COLORS)
  const [profileCard, setProfileCard]   = useState<string | null>(null)
  const [showCalPopup, setShowCalPopup] = useState(false)
  const [editingMessageId, setEditingMessageId] = useState<number | null>(null)
  const [editInput, setEditInput]               = useState('')
  const [onlineUsers, setOnlineUsers]           = useState<string[]>([])
  const [unreadCount, setUnreadCount]           = useState(0)
  const [showMembersPanel, setShowMembersPanel] = useState(true)
  const [notifSettings, setNotifSettings]       = useState<NotifSettings>(DEFAULT_NOTIF)

  // スレッド
  const [threadPanelMessageId, setThreadPanelMessageId] = useState<number | null>(null)
  const [threadParentMessage, setThreadParentMessage]   = useState<Message | null>(null)
  const [threadReplies, setThreadReplies]               = useState<Message[]>([])
  const [threadInput, setThreadInput]                   = useState('')

  // チャンネル操作
  const [showAddModal, setShowAddModal]       = useState(false)
  const [newChannelName, setNewChannelName]   = useState('')
  const [newChannelPrivate, setNewChannelPrivate] = useState(false)
  const [renameTarget, setRenameTarget]       = useState<Channel | null>(null)
  const [renameInput, setRenameInput]         = useState('')
  const [deleteTarget, setDeleteTarget]       = useState<Channel | null>(null)
  const [showInviteModal, setShowInviteModal] = useState(false)
  const [inviteChannelId, setInviteChannelId] = useState<number | null>(null)
  const [inviteInput, setInviteInput]         = useState('')
  const [inviteSuccess, setInviteSuccess]     = useState('')
  const [errorMsg, setErrorMsg] = useState('')

  const socketRef               = useRef<Socket | null>(null)
  const bottomRef               = useRef<HTMLDivElement>(null)
  const attachmentInputRef      = useRef<HTMLInputElement>(null)
  const currentChannelIdRef     = useRef<number | null>(null)
  const isTabFocusedRef         = useRef(true)
  const notifSettingsRef        = useRef<NotifSettings>(DEFAULT_NOTIF)
  const threadPanelMessageIdRef = useRef<number | null>(null)

  useEffect(() => { notifSettingsRef.current = notifSettings }, [notifSettings])
  useEffect(() => { threadPanelMessageIdRef.current = threadPanelMessageId }, [threadPanelMessageId])

  useEffect(() => {
    const savedName = localStorage.getItem('chat_username')
    if (savedName) { setUsername(savedName); setEnteredName(true) }
    try { const c = localStorage.getItem('chat_colors'); if (c) setColors(JSON.parse(c)) } catch {}
    try { const n = localStorage.getItem('chat_notif'); if (n) setNotifSettings(JSON.parse(n)) } catch {}
  }, [])

  useEffect(() => {
    const onFocus = () => { isTabFocusedRef.current = true; setUnreadCount(0) }
    const onBlur  = () => { isTabFocusedRef.current = false }
    window.addEventListener('focus', onFocus)
    window.addEventListener('blur',  onBlur)
    return () => { window.removeEventListener('focus', onFocus); window.removeEventListener('blur', onBlur) }
  }, [])

  useEffect(() => {
    document.title = unreadCount > 0 ? `(${unreadCount}) Cyberdyne Chat` : 'Cyberdyne Chat'
  }, [unreadCount])

  useEffect(() => {
    let el = document.getElementById('chat-theme') as HTMLStyleElement | null
    if (!el) { el = document.createElement('style'); el.id = 'chat-theme'; document.head.appendChild(el) }
    el.textContent = `:root{${buildThemeVars(colors)}}`
  }, [colors])

  useEffect(() => { currentChannelIdRef.current = currentChannelId }, [currentChannelId])
  useEffect(() => {
    setThreadPanelMessageId(null); setThreadParentMessage(null); setThreadReplies([]); setThreadInput('')
  }, [currentChannelId])

  useEffect(() => {
    if (!enteredName) return
    const socket = io({ auth: { username } })
    socketRef.current = socket

    socket.on('channel_list', (chs: Channel[]) => {
      setChannels(chs)
      setCurrentChannelId(prev => {
        if (prev !== null && !chs.find(c => c.id === prev)) {
          const first = chs[0]; if (first) socket.emit('join_channel', first.id); return first?.id ?? null
        }
        return prev
      })
    })
    socket.on('history', ({ channelId, messages: msgs }: { channelId: number; messages: Message[] }) => {
      setCurrentChannelId(channelId); setMessages(msgs)
    })
    socket.on('new_message', (msg: Message) => {
      if (msg.channelId === currentChannelIdRef.current) setMessages(prev => [...prev, msg])
      const ns = notifSettingsRef.current
      const isMention = msg.content.includes(`@${username}`)
      const shouldNotify = ns.trigger === 'all' || isMention
      if (msg.username === username) {
        if (isMention && ns.sound) playNotifSound(ns.soundType)
        return
      }
      if (!isTabFocusedRef.current && ns.badge) setUnreadCount(c => c + 1)
      if (!shouldNotify) return
      if (ns.sound) playNotifSound(ns.soundType)
      if (ns.enabled && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
        const n = new Notification(msg.username, { body: msg.content || '(添付ファイル)', icon: '/favicon.ico', tag: String(msg.id) })
        n.onclick = () => { window.focus(); n.close() }
      }
    })
    socket.on('user_profiles', (profiles: Record<string, UserProfileData>) => setUserProfiles(profiles))
    socket.on('user_statuses', (statuses: Record<string, MeetingStatus>) => setUserStatuses(statuses))
    socket.on('online_users', (users: string[]) => setOnlineUsers(users))
    socket.on('channel_error', (msg: string) => setErrorMsg(msg))
    socket.on('invite_success', (invitee: string) => setInviteSuccess(`${invitee} を招待しました`))
    socket.on('message_edited', (msg: Message) => {
      setMessages(prev => prev.map(m => m.id === msg.id ? msg : m))
      setThreadReplies(prev => prev.map(m => m.id === msg.id ? msg : m))
      setThreadParentMessage(prev => prev?.id === msg.id ? msg : prev)
    })
    socket.on('message_deleted', ({ messageId }: { messageId: number }) => {
      setMessages(prev => prev.filter(m => m.id !== messageId))
      setThreadReplies(prev => prev.filter(m => m.id !== messageId))
      setThreadPanelMessageId(prev => { if (prev === messageId) { setThreadParentMessage(null); return null } return prev })
    })
    socket.on('thread_data', ({ parent, replies }: { parent: Message; replies: Message[] }) => {
      setThreadParentMessage(parent); setThreadReplies(replies); setThreadPanelMessageId(parent.id)
    })
    socket.on('thread_reply', (reply: Message) => {
      if (threadPanelMessageIdRef.current === reply.parentId) {
        setThreadReplies(prev => [...prev, reply])
      }
      if (reply.username !== username && reply.content.includes(`@${username}`)) {
        const ns = notifSettingsRef.current
        if (ns.sound) playNotifSound(ns.soundType)
        if (!isTabFocusedRef.current && ns.badge) setUnreadCount(c => c + 1)
        if (ns.enabled && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
          const n = new Notification(reply.username, { body: reply.content, icon: '/favicon.ico', tag: String(reply.id) })
          n.onclick = () => { window.focus(); n.close() }
        }
      }
    })
    socket.on('reply_count_update', ({ messageId, replyCount }: { messageId: number; replyCount: number }) => {
      setMessages(prev => prev.map(m => m.id === messageId ? { ...m, replyCount } : m))
      setThreadParentMessage(prev => prev?.id === messageId ? { ...prev, replyCount } : prev)
    })

    const params = new URLSearchParams(window.location.search)
    if (params.get('calendar_connected') === '1') {
      socket.emit('calendar_connected')
      window.history.replaceState({}, '', window.location.pathname)
    }
    if (params.get('calendar_error') === '1') {
      setErrorMsg('Google Calendar の連携に失敗しました')
      window.history.replaceState({}, '', window.location.pathname)
    }

    return () => { socket.disconnect() }
  }, [enteredName, username])

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [messages])

  // ---- Handlers ----
  function handleJoin(e: React.FormEvent) {
    e.preventDefault()
    const name = username.trim(); if (!name) return
    localStorage.setItem('chat_username', name); setUsername(name); setEnteredName(true)
  }
  function sendMessage() {
    if ((!input.trim() && !attachment) || !socketRef.current || currentChannelId === null) return
    socketRef.current.emit('send_message', {
      username, content: input.trim(), channelId: currentChannelId,
      attachmentData: attachment?.data ?? null,
      attachmentName: attachment?.name ?? null,
      attachmentType: attachment?.type ?? null,
    })
    setInput(''); setAttachment(null)
  }
  function handleSend(e: React.FormEvent) { e.preventDefault(); sendMessage() }
  function switchChannel(id: number) {
    if (id === currentChannelId) return
    setMessages([]); socketRef.current?.emit('join_channel', id)
  }
  function handleAddChannel(e: React.FormEvent) {
    e.preventDefault(); if (!newChannelName.trim()) return
    setErrorMsg('')
    socketRef.current?.emit('create_channel', { name: newChannelName.trim(), isPrivate: newChannelPrivate })
    setNewChannelName(''); setNewChannelPrivate(false); setShowAddModal(false)
  }
  function handleRename(e: React.FormEvent) {
    e.preventDefault(); if (!renameInput.trim() || !renameTarget) return
    setErrorMsg('')
    socketRef.current?.emit('rename_channel', { id: renameTarget.id, name: renameInput.trim() })
    setRenameTarget(null)
  }
  function handleDelete() {
    if (!deleteTarget) return
    socketRef.current?.emit('delete_channel', deleteTarget.id); setDeleteTarget(null)
  }
  function handleInvite(e: React.FormEvent) {
    e.preventDefault(); if (!inviteInput.trim() || inviteChannelId === null) return
    setErrorMsg(''); setInviteSuccess('')
    socketRef.current?.emit('invite_to_channel', { channelId: inviteChannelId, inviteeUsername: inviteInput.trim() })
    setInviteInput('')
  }
  function handleColorsChange(newColors: ThemeColors) {
    setColors(newColors); localStorage.setItem('chat_colors', JSON.stringify(newColors))
  }
  function handleNotifSettingsChange(s: NotifSettings) {
    setNotifSettings(s); localStorage.setItem('chat_notif', JSON.stringify(s))
  }
  async function handleAvatarUpload(file: File) {
    const imageData = await resizeImageToDataUrl(file)
    const res = await fetch('/api/avatar', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, imageData }) })
    if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error ?? 'Upload failed') }
    const { avatarUrl } = await res.json()
    if (avatarUrl) {
      setUserProfiles(prev => ({ ...prev, [username]: { ...(prev[username] ?? { email: null, title: null }), avatarUrl } }))
      socketRef.current?.emit('update_profile')
    }
  }
  function handleEditSave(messageId: number) {
    const trimmed = editInput.trim(); if (!trimmed) return
    socketRef.current?.emit('edit_message', { messageId, content: trimmed })
    setEditingMessageId(null)
  }
  function handleDeleteMessage(messageId: number) {
    socketRef.current?.emit('delete_message', { messageId })
  }
  function handleOpenThread(messageId: number) {
    setThreadInput(''); socketRef.current?.emit('get_thread', messageId)
  }
  function handleSendThreadReply() {
    if (!threadInput.trim() || !threadParentMessage || !socketRef.current) return
    socketRef.current.emit('send_thread_reply', { content: threadInput.trim(), parentId: threadParentMessage.id })
    setThreadInput('')
  }
  function handleSaveProfileDetails(email: string, title: string) {
    socketRef.current?.emit('update_profile_details', { email, title })
    setUserProfiles(prev => ({
      ...prev,
      [username]: { ...(prev[username] ?? { avatarUrl: null }), email: email || null, title: title || null }
    }))
  }
  async function handleAttachmentSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]; if (!file) return; e.target.value = ''
    setAttachmentLoading(true); setErrorMsg('')
    try {
      if (file.type.startsWith('image/')) {
        if (file.size > 10*1024*1024) { setErrorMsg('画像は10MB以下にしてください'); return }
        setAttachment({ data: await resizeAttachmentImage(file), name: file.name, type: 'image/jpeg' })
      } else {
        if (file.size > 1024*1024) { setErrorMsg('ファイルは1MB以下にしてください'); return }
        setAttachment({ data: await fileToDataUrl(file), name: file.name, type: file.type })
      }
    } catch { setErrorMsg('ファイルの処理に失敗しました') }
    finally { setAttachmentLoading(false) }
  }

  const currentChannel = channels.find(c => c.id === currentChannelId)
  const myAvatarUrl    = userProfiles[username]?.avatarUrl
  const myProfile      = userProfiles[username]
  const myStatus       = userStatuses[username]
  const allUsers           = [...new Set([...messages.map(m => m.username), username])]
  const mentionCandidates  = [...new Set([...allUsers, ...onlineUsers])]

  // ---- Login Screen ----
  if (!enteredName) {
    return (
      <div className="min-h-screen bg-gray-900 flex items-center justify-center">
        <div className="bg-gray-800 rounded-2xl p-8 w-80 shadow-2xl">
          <h1 className="text-2xl font-bold text-white mb-6 text-center">チャットへようこそ</h1>
          <form onSubmit={handleJoin} className="flex flex-col gap-4">
            <input type="text" value={username} onChange={e => setUsername(e.target.value)} placeholder="ユーザー名を入力" className="bg-gray-700 text-white rounded-lg px-4 py-2 outline-none focus:ring-2 focus:ring-blue-500 placeholder-gray-400" maxLength={20} autoFocus />
            <button type="submit" className="theme-accent-btn text-white font-semibold py-2 rounded-lg">参加する</button>
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
          <button onClick={() => { setShowAddModal(true); setNewChannelName(''); setNewChannelPrivate(false); setErrorMsg('') }} className="sidebar-icon-btn" title="チャンネルを追加"><PlusIcon /></button>
        </div>
        <nav className="flex-1 overflow-y-auto py-2">
          {channels.map(ch => (
            <ChannelItem key={ch.id} channel={ch} isActive={ch.id === currentChannelId}
              onClick={() => switchChannel(ch.id)}
              onRename={() => { setRenameTarget(ch); setRenameInput(ch.name); setErrorMsg('') }}
              onDelete={() => setDeleteTarget(ch)}
              onInvite={() => { setInviteChannelId(ch.id); setShowInviteModal(true); setInviteInput(''); setInviteSuccess(''); setErrorMsg('') }}
            />
          ))}
          {channels.length === 0 && <p className="text-xs px-4 py-2 theme-sidebar-muted">チャンネルがありません</p>}
        </nav>
        {/* User footer */}
        <div className="border-t border-white/10 px-3 py-2.5 flex items-center gap-2">
          <div className="relative shrink-0">
            <button onClick={() => setProfileCard(username)} className="block rounded-full focus:outline-none" title="プロフィールを見る">
              <Avatar username={username} avatarUrl={myAvatarUrl} size={32} />
            </button>
            {myStatus?.inMeeting && (
              <button
                className="absolute -top-1 -right-1 text-xs leading-none cursor-pointer hover:scale-125 transition-transform"
                onClick={() => setShowCalPopup(v => !v)}
                title="予定の詳細を見る"
              >🗓️</button>
            )}
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium truncate">{username}</p>
            {myStatus?.inMeeting && (
              <p className="text-xs theme-sidebar-muted truncate">In a meeting ～{formatTime(myStatus.endTime)}</p>
            )}
          </div>
          <button onClick={() => setShowSettings(true)} className="sidebar-icon-btn p-1" title="設定"><GearIcon /></button>
        </div>
      </aside>

      {/* Chat area */}
      <div className="theme-chat-bg flex-1 flex flex-col min-w-0">
        <header className="bg-gray-800/90 backdrop-blur border-b border-white/10 px-6 py-3 flex items-center gap-2">
          {currentChannel ? (
            <>
              {currentChannel.isPrivate ? <LockIcon /> : <HashIcon />}
              <span className="text-white font-semibold">{currentChannel.name}</span>
              {currentChannel.isPrivate && (
                <>
                  <span className="text-gray-500 text-xs ml-1">{currentChannel.members.length}人のメンバー</span>
                  <button onClick={() => { setInviteChannelId(currentChannel.id); setShowInviteModal(true); setInviteInput(''); setInviteSuccess(''); setErrorMsg('') }}
                    className="ml-1 text-xs text-blue-400 hover:text-blue-300 px-2 py-0.5 border border-blue-400/40 rounded-full transition-colors">
                    + 招待
                  </button>
                </>
              )}
            </>
          ) : <span className="text-gray-400">チャンネルを選択してください</span>}
          <div className="ml-auto flex items-center gap-2">
            <button onClick={() => setShowMembersPanel(v => !v)}
              className={`p-1.5 rounded-md transition-colors ${showMembersPanel ? 'text-white bg-white/10' : 'text-gray-400 hover:text-white'}`}
              title="メンバー一覧">
              <PeopleIcon />
            </button>
          </div>
        </header>

        <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3">
          {currentChannel && messages.length === 0 && (
            <p className="text-center mt-10 theme-chat-muted">#{currentChannel.name} にメッセージがまだありません</p>
          )}
          {messages.map(msg => {
            const isMe      = msg.username === username
            const avatarUrl = userProfiles[msg.username]?.avatarUrl
            const msgStatus = userStatuses[msg.username]
            const isEditing = editingMessageId === msg.id
            return (
              <div key={msg.id} className={`flex items-end gap-2 group ${isMe ? 'justify-end' : 'justify-start'}`}>
                {/* Other user avatar — clickable */}
                {!isMe && (
                  <div className="relative shrink-0">
                    <button onClick={() => setProfileCard(msg.username)} className="block rounded-full focus:outline-none" title={`${msg.username} のプロフィール`}>
                      <Avatar username={msg.username} avatarUrl={avatarUrl} size={32} />
                    </button>
                    {msgStatus?.inMeeting && (
                      <span className="absolute -top-1 -right-1 text-xs leading-none pointer-events-none">🗓️</span>
                    )}
                  </div>
                )}

                {/* Action buttons — own messages: reply + edit + delete */}
                {isMe && !isEditing && (
                  <div className="opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-0.5 self-center">
                    <button onClick={() => handleOpenThread(msg.id)}
                      className="p-1.5 rounded-md text-gray-400 hover:text-blue-400 hover:bg-blue-500/10 transition-colors" title="返信">
                      <ReplyIcon />
                    </button>
                    <button onClick={() => { setEditingMessageId(msg.id); setEditInput(msg.content) }}
                      className="p-1.5 rounded-md text-gray-400 hover:text-white hover:bg-gray-700/60 transition-colors" title="編集">
                      <PencilIcon />
                    </button>
                    <button onClick={() => handleDeleteMessage(msg.id)}
                      className="p-1.5 rounded-md text-gray-400 hover:text-red-400 hover:bg-red-500/10 transition-colors" title="削除">
                      <TrashIcon />
                    </button>
                  </div>
                )}

                <div className={`flex flex-col ${isEditing ? 'w-64' : 'max-w-xs lg:max-w-md'} ${isMe ? 'items-end' : 'items-start'}`}>
                  {/* Username + meeting status */}
                  {!isMe && (
                    <div className="flex items-center gap-1.5 mb-1 ml-1 flex-wrap">
                      <button onClick={() => setProfileCard(msg.username)} className="text-xs theme-chat-muted hover:underline focus:outline-none">
                        {msg.username}
                      </button>
                      {msgStatus?.inMeeting && (
                        <span className="text-xs text-blue-400">🗓️ In a meeting ～{formatTime(msgStatus.endTime)}</span>
                      )}
                    </div>
                  )}

                  {isEditing ? (
                    <div className="flex flex-col gap-1.5 w-full">
                      <textarea
                        value={editInput}
                        onChange={e => setEditInput(e.target.value)}
                        className="bg-gray-700 text-white rounded-xl px-3 py-2 text-sm resize-none outline-none focus:ring-2 focus:ring-blue-500 w-full"
                        rows={Math.max(1, Math.min(5, editInput.split('\n').length + 1))}
                        autoFocus
                        onKeyDown={e => {
                          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); handleEditSave(msg.id) }
                          if (e.key === 'Escape') setEditingMessageId(null)
                        }}
                      />
                      <div className="flex gap-1.5 justify-end text-xs">
                        <button onClick={() => setEditingMessageId(null)} className="px-2 py-1 text-gray-400 hover:text-white transition-colors">キャンセル</button>
                        <button onClick={() => handleEditSave(msg.id)} className="px-2 py-1 theme-accent-btn text-white rounded-md">保存</button>
                      </div>
                    </div>
                  ) : (
                    <>
                      {(msg.content || !msg.attachmentData) && (
                        <div className={`px-4 py-2 rounded-2xl text-sm ${isMe ? 'theme-msg-self rounded-tr-none' : 'theme-msg-other rounded-tl-none'}`}>
                          {msg.content ? renderWithMentions(msg.content, username) : '(添付ファイル)'}
                        </div>
                      )}
                      {msg.attachmentData && (
                        <div className={`mt-1 flex flex-col ${isMe ? 'items-end' : 'items-start'}`}>
                          {msg.attachmentType?.startsWith('image/') ? (
                            <img src={msg.attachmentData} alt={msg.attachmentName ?? 'image'} className="max-w-xs max-h-64 rounded-xl object-contain cursor-pointer" loading="lazy"
                              onClick={() => { const a = document.createElement('a'); a.href = msg.attachmentData!; a.download = msg.attachmentName??'image'; a.click() }} />
                          ) : (
                            <a href={msg.attachmentData} download={msg.attachmentName} className="flex items-center gap-2 bg-gray-700/70 hover:bg-gray-700 px-3 py-2 rounded-xl text-sm text-gray-300 transition-colors max-w-xs">
                              <FileIcon /><span className="truncate">{msg.attachmentName}</span>
                            </a>
                          )}
                        </div>
                      )}
                    </>
                  )}

                  <span className="text-xs mt-1 mx-1 theme-chat-muted">
                    {new Date(msg.createdAt).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })}
                  </span>
                  {(msg.replyCount ?? 0) > 0 && (
                    <button onClick={() => handleOpenThread(msg.id)}
                      className="mt-0.5 mx-1 flex items-center gap-1 text-xs text-blue-400 hover:text-blue-300 hover:underline transition-colors">
                      <ReplyIcon />返信 {msg.replyCount}件
                    </button>
                  )}
                </div>

                {/* Reply button — other user's messages */}
                {!isMe && !isEditing && (
                  <div className="opacity-0 group-hover:opacity-100 transition-opacity flex items-center self-center">
                    <button onClick={() => handleOpenThread(msg.id)}
                      className="p-1.5 rounded-md text-gray-400 hover:text-blue-400 hover:bg-blue-500/10 transition-colors" title="返信">
                      <ReplyIcon />
                    </button>
                  </div>
                )}

                {/* My avatar — clickable */}
                {isMe && (
                  <div className="relative shrink-0">
                    <button onClick={() => setProfileCard(msg.username)} className="block rounded-full focus:outline-none" title="自分のプロフィール">
                      <Avatar username={msg.username} avatarUrl={myAvatarUrl} size={32} />
                    </button>
                    {myStatus?.inMeeting && (
                      <span className="absolute -top-1 -right-1 text-xs leading-none pointer-events-none">🗓️</span>
                    )}
                  </div>
                )}
              </div>
            )
          })}
          <div ref={bottomRef} />
        </div>

        {/* Input area */}
        <form onSubmit={handleSend} className="bg-gray-800/90 backdrop-blur border-t border-white/10">
          {attachment && (
            <div className="flex items-center gap-2 px-4 py-2 border-b border-white/10">
              {attachment.type.startsWith('image/') ? (
                <img src={attachment.data} alt="preview" className="h-12 w-12 rounded-lg object-cover" />
              ) : (
                <div className="flex items-center gap-2 bg-gray-700 px-3 py-1.5 rounded-lg text-sm text-gray-300">
                  <FileIcon /><span className="truncate max-w-48">{attachment.name}</span>
                </div>
              )}
              <button type="button" onClick={() => setAttachment(null)} className="ml-auto text-gray-400 hover:text-white transition-colors"><XIcon /></button>
            </div>
          )}
          {errorMsg && <p className="px-4 py-1 text-red-400 text-xs">{errorMsg}</p>}
          <div className="flex gap-2 px-4 py-3">
            <button type="button" onClick={() => attachmentInputRef.current?.click()} disabled={!currentChannel || attachmentLoading} className="text-gray-400 hover:text-white transition-colors p-1 disabled:opacity-40" title="ファイルを添付">
              {attachmentLoading ? <SpinnerIcon /> : <PaperclipIcon />}
            </button>
            <input ref={attachmentInputRef} type="file" accept="image/*,.pdf,.doc,.docx,.txt,.zip,.csv,.xls,.xlsx" className="hidden" onChange={handleAttachmentSelect} />
            <MentionInput
              value={input} onChange={setInput} onSubmit={sendMessage}
              placeholder={currentChannel ? `#${currentChannel.name} にメッセージを送信` : 'チャンネルを選択してください'}
              disabled={!currentChannel}
              className="w-full bg-gray-700 text-white rounded-full px-4 py-2 outline-none focus:ring-2 focus:ring-blue-500 placeholder-gray-400 text-sm disabled:opacity-50"
              maxLength={500} allUsers={mentionCandidates} />
            <button type="submit" disabled={(!input.trim() && !attachment) || !currentChannel} className="theme-accent-btn text-white rounded-full px-5 py-2 font-semibold text-sm">送信</button>
          </div>
        </form>
      </div>

      {/* ---- Thread panel ---- */}
      {threadPanelMessageId !== null && threadParentMessage !== null && (
        <ThreadPanel
          parentMessage={threadParentMessage}
          replies={threadReplies}
          userProfiles={userProfiles}
          threadInput={threadInput}
          onInputChange={setThreadInput}
          onSend={handleSendThreadReply}
          onClose={() => { setThreadPanelMessageId(null); setThreadParentMessage(null); setThreadReplies([]) }}
          onAvatarClick={setProfileCard}
          allUsers={mentionCandidates}
          currentUsername={username}
        />
      )}

      {/* ---- Members panel (hidden when thread panel is open) ---- */}
      {showMembersPanel && currentChannel && threadPanelMessageId === null && (
        <MembersPanel
          channel={currentChannel}
          onlineUsers={onlineUsers}
          allUsers={allUsers}
          userProfiles={userProfiles}
          userStatuses={userStatuses}
          onAvatarClick={setProfileCard}
        />
      )}

      {/* ---- Calendar popup (sidebar badge click) ---- */}
      {showCalPopup && myStatus?.inMeeting && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setShowCalPopup(false)} />
          <div className="fixed bottom-16 left-2 z-50 w-64 bg-gray-800 border border-gray-700 rounded-xl p-4 shadow-2xl">
            <div className="flex items-center justify-between mb-3">
              <span className="text-white text-sm font-semibold">🗓️ 現在の予定</span>
              <button onClick={() => setShowCalPopup(false)} className="text-gray-400 hover:text-white transition-colors"><XIcon /></button>
            </div>
            <p className="text-gray-100 text-sm font-medium leading-snug">{myStatus.eventTitle || '（タイトルなし）'}</p>
            <p className="text-gray-400 text-xs mt-2">終了: {formatTime(myStatus.endTime)}</p>
          </div>
        </>
      )}

      {/* ---- Profile card ---- */}
      {profileCard && (
        <ProfileCard
          username={profileCard}
          profile={userProfiles[profileCard]}
          status={userStatuses[profileCard]}
          onClose={() => setProfileCard(null)}
        />
      )}

      {/* ---- Channel modals ---- */}
      {showAddModal && (
        <Modal onClose={() => setShowAddModal(false)} title="チャンネルを追加">
          <form onSubmit={handleAddChannel} className="flex flex-col gap-4">
            <input type="text" value={newChannelName} onChange={e => setNewChannelName(e.target.value)} placeholder="チャンネル名" className="bg-gray-700 text-white rounded-lg px-4 py-2 outline-none focus:ring-2 focus:ring-blue-500 placeholder-gray-400 text-sm" maxLength={50} autoFocus />
            <div className="flex gap-2">
              {([{label:'🌐 パブリック',value:false},{label:'🔒 プライベート',value:true}] as const).map(opt => (
                <button key={String(opt.value)} type="button" onClick={() => setNewChannelPrivate(opt.value)}
                  className={`flex-1 py-2 text-sm rounded-lg border transition-colors ${newChannelPrivate===opt.value?'border-blue-500 text-blue-400 bg-blue-500/10':'border-gray-600 text-gray-400 hover:border-gray-400'}`}>
                  {opt.label}
                </button>
              ))}
            </div>
            {newChannelPrivate && <p className="text-gray-400 text-xs">作成後、メンバーを招待できます。</p>}
            {errorMsg && <p className="text-red-400 text-xs">{errorMsg}</p>}
            <div className="flex gap-2 justify-end">
              <button type="button" onClick={() => setShowAddModal(false)} className="px-4 py-2 text-sm text-gray-400 hover:text-white transition-colors">キャンセル</button>
              <button type="submit" disabled={!newChannelName.trim()} className="theme-accent-btn text-white px-4 py-2 rounded-lg text-sm font-semibold">追加</button>
            </div>
          </form>
        </Modal>
      )}

      {renameTarget && (
        <Modal onClose={() => setRenameTarget(null)} title="チャンネル名を変更">
          <form onSubmit={handleRename} className="flex flex-col gap-4">
            <input type="text" value={renameInput} onChange={e => setRenameInput(e.target.value)} className="bg-gray-700 text-white rounded-lg px-4 py-2 outline-none focus:ring-2 focus:ring-blue-500 text-sm" maxLength={50} autoFocus />
            {errorMsg && <p className="text-red-400 text-xs">{errorMsg}</p>}
            <div className="flex gap-2 justify-end">
              <button type="button" onClick={() => setRenameTarget(null)} className="px-4 py-2 text-sm text-gray-400 hover:text-white transition-colors">キャンセル</button>
              <button type="submit" disabled={!renameInput.trim() || renameInput===renameTarget.name} className="theme-accent-btn text-white px-4 py-2 rounded-lg text-sm font-semibold">変更</button>
            </div>
          </form>
        </Modal>
      )}

      {deleteTarget && (
        <Modal onClose={() => setDeleteTarget(null)} title="チャンネルを削除">
          <p className="text-gray-300 text-sm mb-4"><span className="text-white font-semibold">#{deleteTarget.name}</span> を削除しますか？<br />このチャンネルのメッセージもすべて削除されます。</p>
          <div className="flex gap-2 justify-end">
            <button onClick={() => setDeleteTarget(null)} className="px-4 py-2 text-sm text-gray-400 hover:text-white transition-colors">キャンセル</button>
            <button onClick={handleDelete} className="bg-red-600 hover:bg-red-500 text-white px-4 py-2 rounded-lg text-sm font-semibold transition-colors">削除する</button>
          </div>
        </Modal>
      )}

      {showInviteModal && inviteChannelId !== null && (
        <Modal onClose={() => { setShowInviteModal(false); setInviteSuccess('') }} title="メンバーを招待">
          {inviteSuccess ? (
            <div className="text-center py-2">
              <p className="text-green-400 font-medium">{inviteSuccess}</p>
              <button onClick={() => { setShowInviteModal(false); setInviteSuccess('') }} className="mt-4 text-gray-400 hover:text-white text-sm transition-colors">閉じる</button>
            </div>
          ) : (
            <form onSubmit={handleInvite} className="flex flex-col gap-4">
              <p className="text-gray-400 text-sm">招待するユーザー名を入力してください</p>
              <input type="text" value={inviteInput} onChange={e => setInviteInput(e.target.value)} placeholder="ユーザー名" className="bg-gray-700 text-white rounded-lg px-4 py-2 outline-none focus:ring-2 focus:ring-blue-500 placeholder-gray-400 text-sm" maxLength={20} autoFocus />
              {errorMsg && <p className="text-red-400 text-xs">{errorMsg}</p>}
              <div className="flex gap-2 justify-end">
                <button type="button" onClick={() => setShowInviteModal(false)} className="px-4 py-2 text-sm text-gray-400 hover:text-white transition-colors">キャンセル</button>
                <button type="submit" disabled={!inviteInput.trim()} className="theme-accent-btn text-white px-4 py-2 rounded-lg text-sm font-semibold">招待する</button>
              </div>
            </form>
          )}
        </Modal>
      )}

      {showSettings && (
        <SettingsModal
          username={username}
          myProfile={myProfile}
          colors={colors}
          onColorsChange={handleColorsChange}
          onAvatarUpload={handleAvatarUpload}
          onSaveProfileDetails={handleSaveProfileDetails}
          notifSettings={notifSettings}
          onNotifSettingsChange={handleNotifSettingsChange}
          onClose={() => setShowSettings(false)}
        />
      )}
    </div>
  )
}

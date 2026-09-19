// ThemeSelect —— 与 dsh 官方设置下拉视觉一致的自建受控下拉（#90 用户要求）。
// 样式 token 1:1 提取自官方 model-selection 下拉（_root/_trigger/_menu/_option）：
//   触发器 28px/圆角24/label-secondary；菜单 specific-menu + elevation-prominent + 圆角20；
//   选项 38px/圆角10/hover interactive-bg-hover/选中高亮/禁用 label-dimmed。
// 纯 JSX + hooks；键盘可达（Enter/Escape/↑↓）；点击外部关闭。
import React, { useCallback, useEffect, useRef, useState } from 'react'

export interface ThemeSelectOption {
  value: string
  label: string
}

export interface ThemeSelectProps {
  value: string
  options: ThemeSelectOption[]
  onChange: (value: string) => void
  /** 占位（value 不在 options 时显示） */
  placeholder?: string
  style?: React.CSSProperties
  disabled?: boolean
}

const TRIGGER_STYLE: React.CSSProperties = {
  minWidth: 0,
  width: '100%',
  height: 28,
  color: 'var(--dsw-alias-label-secondary)',
  cursor: 'pointer',
  background: 'transparent',
  border: 'none',
  borderRadius: 24,
  outline: 'none',
  alignItems: 'center',
  gap: 4,
  padding: '0 4px 0 8px',
  fontSize: 13,
  fontWeight: 500,
  lineHeight: '20px',
  display: 'flex',
}

const MENU_STYLE: React.CSSProperties = {
  zIndex: 1100,
  background: 'var(--dsw-specific-menu)',
  boxShadow: 'var(--dsw-elevation-prominent)',
  color: 'var(--dsw-alias-label-primary)',
  minWidth: 'min(240px, 100%)',
  maxHeight: 'min(360px, 60vh)',
  borderRadius: 20,
  padding: 4,
  position: 'absolute',
  top: 'calc(100% + 4px)',
  left: 0,
  right: 0,
  overflowY: 'auto',
  overflowX: 'hidden',
}

const OPTION_BASE: React.CSSProperties = {
  boxSizing: 'border-box',
  width: '100%',
  minHeight: 38,
  color: 'inherit',
  textAlign: 'left' as const,
  cursor: 'pointer',
  background: 'transparent',
  border: 'none',
  borderRadius: 10,
  outline: 'none',
  alignItems: 'center',
  gap: 8,
  padding: '6px 8px',
  display: 'flex',
  fontSize: 13,
}

export function ThemeSelect({ value, options, onChange, placeholder, style, disabled }: ThemeSelectProps): React.ReactElement {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  // 点击外部 / Escape 关闭
  useEffect(() => {
    if (!open) return
    const onDown = (ev: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(ev.target as Node)) setOpen(false)
    }
    const onKey = (ev: KeyboardEvent): void => {
      if (ev.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  // 打开时滚动到选中项
  useEffect(() => {
    if (!open || !listRef.current) return
    const sel = listRef.current.querySelector('[data-selected="1"]')
    sel?.scrollIntoView({ block: 'nearest' })
  }, [open])

  const pick = useCallback(
    (v: string): void => {
      setOpen(false)
      if (v !== value) onChange(v)
    },
    [onChange, value],
  )

  const onMenuKey = useCallback(
    (ev: React.KeyboardEvent): void => {
      const idx = options.findIndex((o) => o.value === value)
      if (ev.key === 'ArrowDown') {
        ev.preventDefault()
        const next = options[Math.min(idx + 1, options.length - 1)]
        if (next) onChange(next.value)
      } else if (ev.key === 'ArrowUp') {
        ev.preventDefault()
        const next = options[Math.max(idx - 1, 0)]
        if (next) onChange(next.value)
      } else if (ev.key === 'Enter') {
        ev.preventDefault()
        if (value) onChange(value)
      }
    },
    [options, onChange, value],
  )

  const current = options.find((o) => o.value === value)

  return (
    <div ref={rootRef} style={{ minWidth: 0, position: 'relative', ...(style ?? {}) }} onKeyDown={onMenuKey}>
      <button
        type="button"
        data-theme-select-trigger="1"
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        style={{ ...TRIGGER_STYLE, opacity: disabled ? 0.5 : 1 }}
      >
        <span
          style={{
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            minWidth: 0,
            overflow: 'hidden',
            flex: 1,
            textAlign: 'left' as const,
          }}
        >
          {current?.label ?? placeholder ?? ''}
        </span>
        <span
          style={{
            color: 'var(--dsw-alias-label-caption)',
            flex: 'none',
            transition: 'transform .12s',
            transform: open ? 'rotate(180deg)' : undefined,
          }}
        >
          ▾
        </span>
      </button>
      {open && (
        <div ref={listRef} style={MENU_STYLE} role="listbox">
          {options.length === 0 && (
            <div style={{ color: 'var(--dsw-alias-label-tertiary)', padding: 10, fontSize: 13, lineHeight: '20px' }}>无选项</div>
          )}
          {options.map((o) => (
            <button
              key={o.value}
              type="button"
              data-theme-select-option="1"
              data-selected={o.value === value ? '1' : undefined}
              onClick={() => {
                setOpen(false)
                onChange(o.value)
              }}
              style={{
                ...OPTION_BASE,
                background:
                  o.value === value ? 'var(--dsw-alias-interactive-bg-hover)' : 'transparent',
              }}
            >
              {o.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

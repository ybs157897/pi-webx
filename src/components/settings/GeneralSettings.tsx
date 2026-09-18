/**
 * The `通用设置` section — dsh's first settings entry, and where its surface
 * keeps preferences that are not about providers or plugins: appearance, and
 * (ours) which renderer draws agent UI.
 *
 * Both controls moved here from elsewhere in the shell: the theme used to be a
 * rail button in the sidebar footer and the renderer a segmented control in the
 * composer. dsh keeps neither in those places — its composer carries the model
 * and the send action, and its sidebar ends on `设置` — so they live in the
 * settings surface, which is the one place a preference belongs.
 *
 * Rows follow the same shape as the Models section: label and description on the
 * left, the control right-aligned, in the same row card.
 */

import type { ReactNode } from 'react'
import { theme } from 'antd'
import { t } from './copy.ts'
import styles from './ModelsSection.module.css'

/** One preference row: title, explanation, and a right-aligned control. */
function SettingRow({
  title,
  description,
  children,
}: {
  title: string
  description: string
  children: ReactNode
}): ReactNode {
  return (
    <li className={styles['rowCard']}>
      <div className={styles['rowHead']}>
        <span className={styles['rowIdentity']}>
          <span className={styles['rowName']}>{title}</span>
          <span className={styles['rowTag']}>{description}</span>
        </span>
        <span className={styles['rowActions']}>{children}</span>
      </div>
    </li>
  )
}

/** A small exclusive choice, rendered as the outline buttons the section uses. */
function Choice<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T
  options: readonly { id: T; label: string }[]
  onChange: (next: T) => void
}): ReactNode {
  const { token } = theme.useToken()
  return (
    <>
      {options.map((option) => {
        const active = option.id === value
        return (
          <button
            key={option.id}
            type="button"
            className={styles['secondaryButton']}
            aria-pressed={active}
            style={active ? { color: token.colorPrimary, borderColor: token.colorPrimary } : undefined}
            onClick={() => { onChange(option.id) }}
          >
            {option.label}
          </button>
        )
      })}
    </>
  )
}

/** Appearance and renderer preferences. */
export type ThemePreference = 'light' | 'dark' | 'system'
export type RenderStylePreference = 'ours' | 'tokui'

export function GeneralSettings({
  themeMode,
  onThemeModeChange,
  renderStyle,
  onRenderStyleChange,
}: {
  themeMode: ThemePreference
  onThemeModeChange: (next: ThemePreference) => void
  renderStyle: RenderStylePreference
  onRenderStyleChange: (next: RenderStylePreference) => void
}): ReactNode {
  return (
    <div className={styles['section']}>
      <p className={styles['intro']}>{t('generalIntro')}</p>
      <ul className={styles['rows']}>
        <SettingRow title={t('appearance')} description={t('appearanceHint')}>
          <Choice
            value={themeMode}
            onChange={onThemeModeChange}
            options={[
              { id: 'light', label: t('themeLight') },
              { id: 'dark', label: t('themeDark') },
              { id: 'system', label: t('themeSystem') },
            ]}
          />
        </SettingRow>
        <SettingRow title={t('renderer')} description={t('rendererHint')}>
          <Choice
            value={renderStyle}
            onChange={onRenderStyleChange}
            options={[
              { id: 'ours', label: t('rendererOurs') },
              { id: 'tokui', label: t('rendererTokui') },
            ]}
          />
        </SettingRow>
      </ul>
    </div>
  )
}

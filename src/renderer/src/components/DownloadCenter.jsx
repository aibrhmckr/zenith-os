/* eslint-disable react/prop-types -- Main-owned task snapshots. */
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import SettingsIcon from './SettingsIcon'
import InputHint from './InputHint'
import { useI18n } from '../hooks/i18n'
import {
  COMPLETED_HOLD_MS,
  COMPLETED_FADE_MS,
  taskVisibility,
  taskTitle,
  taskError,
  isUpdateTask
} from '../hooks/downloadPresentation'

/** Match the visible history, including expiry; active work is never cleared. */
export function NotificationClearButton({ tasks, onClear }) {
  const { t } = useI18n()
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (!tasks.some((task) => task.status === 'completed')) return
    const timer = setInterval(() => setNow(Date.now()), 400)
    return () => clearInterval(timer)
  }, [tasks])
  const clearable = tasks.some(
    (task) => !['active', 'queued'].includes(task.status) && taskVisibility(task, now) !== 'hidden'
  )
  return (
    <button
      data-clear-notifications
      className="console-button"
      disabled={!clearable}
      onClick={onClear}
    >
      <InputHint keyboard="X" gamepad="X">
        {t('clear')}
      </InputHint>
    </button>
  )
}

/** Notifications only: update cards navigate to Settings without starting maintenance. */
export default function DownloadCenter({ tasks, onOpenUpdates }) {
  const { t } = useI18n()
  const [now, setNow] = useState(Date.now)
  const root = useRef(null),
    focusedTask = useRef(null)
  const visibleTasks = tasks.filter((task) => taskVisibility(task, now) !== 'hidden')
  useEffect(() => {
    const deadlines = tasks
      .filter((task) => task.status === 'completed')
      .flatMap((task) => [
        task.updatedAt + COMPLETED_HOLD_MS,
        task.updatedAt + COMPLETED_HOLD_MS + COMPLETED_FADE_MS
      ])
    let timer
    const tick = () => {
      const current = Date.now()
      setNow(current)
      const pending = deadlines.filter((deadline) => deadline > current)
      if (pending.length) timer = setTimeout(tick, Math.min(...pending) - current)
    }
    timer = setTimeout(tick, 0)
    return () => clearTimeout(timer)
  }, [tasks])
  useLayoutEffect(() => {
    const current = document.activeElement?.closest('[data-download-task]')?.dataset.downloadTask
    if (current) focusedTask.current = current
    if (
      focusedTask.current &&
      !visibleTasks.some((task) => task.id === focusedTask.current) &&
      document.activeElement === document.body
    ) {
      const target =
        root.current?.querySelector('[data-focusable]') ||
        root.current?.closest('dialog')?.querySelector('[data-modal-close]')
      target?.focus({ preventScroll: true })
      focusedTask.current = null
    }
  }, [visibleTasks])
  return (
    <div
      className="download-center"
      ref={root}
      onFocusCapture={(event) => {
        focusedTask.current = event.target.closest('[data-download-task]')?.dataset.downloadTask
      }}
    >
      {!visibleTasks.length && (
        <div data-no-downloads role="status" className="notifications-empty">
          <SettingsIcon name="bell" />
          <strong>{t('noNotifications')}</strong>
          <p>{t('notificationsHelp')}</p>
        </div>
      )}
      <ul className="space-y-3" aria-live="polite">
        {visibleTasks.map((task, index) => (
          <li
            key={task.id}
            data-download-task={task.id}
            className="download-task rounded-xl border border-white/15 p-3"
            data-leaving={taskVisibility(task, now) === 'leaving' || undefined}
            style={{ '--task-fade-duration': COMPLETED_FADE_MS + 'ms' }}
            tabIndex={0}
            data-focusable
            data-initial-focus={index === 0 ? true : undefined}
            role={isUpdateTask(task) ? 'button' : undefined}
            onClick={() => {
              if (isUpdateTask(task)) onOpenUpdates()
            }}
            onKeyDown={(event) => {
              if (isUpdateTask(task) && ['Enter', ' '].includes(event.key)) {
                event.preventDefault()
                event.stopPropagation()
                if (!event.repeat) onOpenUpdates()
              }
            }}
          >
            <div className="flex items-center justify-between gap-3">
              <strong>{taskTitle(task, t)}</strong>
              <span>
                {task.status === 'active' && task.percent !== null
                  ? task.percent + '%'
                  : t('task_' + task.status)}
              </span>
            </div>
            {task.status === 'active' && (
              <progress
                className="w-full mt-2"
                max="100"
                value={task.percent ?? undefined}
                aria-label={taskTitle(task, t)}
              />
            )}
            {task.error && <p className="text-sm text-rose-300">{taskError(task, t)}</p>}
            {typeof task.version === 'string' && /^v?\d[\w.+-]{0,60}$/.test(task.version) && (
              <p className="text-sm opacity-70">{task.version}</p>
            )}
            {task.kind === 'softwareUpdate' && task.status === 'completed' && (
              <p className="text-sm text-emerald-200 mt-2">
                {t(task.phase === 'ready-to-install' ? 'appUpdateReady' : 'softwareUpdateComplete')}
              </p>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}

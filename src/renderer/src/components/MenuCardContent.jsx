/* eslint-disable react/prop-types -- Shared presentational button content. */
import SettingsIcon from './SettingsIcon'

/** Button owners retain their existing actions, focus indices and busy state. */
export default function MenuCardContent({ icon, title, description }) {
  return (
    <>
      <span className="settings-card-icon">
        <SettingsIcon name={icon} />
      </span>
      <span className="settings-card-copy">
        <strong>{title}</strong>
        {description && <span>{description}</span>}
      </span>
      <span className="settings-card-chevron">
        <SettingsIcon name="chevron" />
      </span>
    </>
  )
}

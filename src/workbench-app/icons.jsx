/**
 * 内联 SVG 图标集（不引图标库）。全部 24 网格、1.8 描边、`currentColor`，
 * 尺寸由 `size` 控制，装饰性图标一律 `aria-hidden`——可点图标请用外层
 * `<button aria-label>` 描述语义，别给 SVG 加 title。
 * @module src/icons
 */

/**
 * 造一个图标组件。
 * @param children - SVG 子节点。
 * @returns 接受 `{ size, className, ...rest }` 的组件。
 */
function icon(children) {
  return function Icon({ size = 20, className, ...rest }) {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        focusable="false"
        className={className}
        {...rest}
      >
        {children}
      </svg>
    )
  }
}

export const IconHome = icon(
  <path d="M4 10.4 12 4l8 6.4V19a1.6 1.6 0 0 1-1.6 1.6h-3.1v-5.4H8.7v5.4H5.6A1.6 1.6 0 0 1 4 19Z" />,
)

export const IconTasks = icon(
  <>
    <rect x="3.6" y="4" width="16.8" height="16" rx="4" />
    <path d="M7.8 9.4l1.7 1.7 3.2-3.4M15.6 9.9h2.1" />
    <path d="M7.8 15.6l1.7 1.7 3.2-3.4M15.6 16.1h2.1" />
  </>,
)

export const IconWorks = icon(
  <>
    <rect x="3.4" y="7.4" width="17.2" height="12.2" rx="3.2" />
    <path d="M9 7.4V6a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v1.4" />
    <path d="M3.4 12.4h17.2" />
  </>,
)

export const IconTrend = icon(
  <>
    <path d="M3.6 15.8 9.2 10.2l3.6 3.6 7.6-7.6" />
    <path d="M15.6 6.2h4.8v4.8" />
  </>,
)

export const IconRun = icon(
  <>
    <path d="M6.6 8.2v7.6M3.6 10.2v3.6M17.4 8.2v7.6M20.4 10.2v3.6M6.6 12h10.8" />
  </>,
)

export const IconMeal = icon(
  <>
    <path d="M4 11.4h16a8 8 0 0 1-16 0Z" />
    <path d="M9.2 8.2c0-1.6 1.4-1.7 1.4-3.4M13.4 8.2c0-1.6 1.4-1.7 1.4-3.4" />
  </>,
)

export const IconWallet = icon(
  <>
    <rect x="3.4" y="5.8" width="17.2" height="12.8" rx="3.2" />
    <path d="M3.4 10.4h17.2" />
    <circle cx="16.4" cy="14.6" r="1.3" />
  </>,
)

export const IconPaw = icon(
  <>
    <circle cx="12" cy="15.2" r="3.4" />
    <ellipse cx="6.4" cy="11.4" rx="2" ry="2.5" />
    <ellipse cx="17.6" cy="11.4" rx="2" ry="2.5" />
    <ellipse cx="9.5" cy="6.8" rx="1.9" ry="2.4" />
    <ellipse cx="14.5" cy="6.8" rx="1.9" ry="2.4" />
  </>,
)

export const IconHeart = icon(
  <path d="M12 19.8s-7.4-4.5-7.4-9.4a4.3 4.3 0 0 1 7.4-2.8 4.3 4.3 0 0 1 7.4 2.8c0 4.9-7.4 9.4-7.4 9.4Z" />,
)

export const IconReview = icon(
  <path d="M20.2 14.6A8.3 8.3 0 0 1 9.4 3.8a8.6 8.6 0 1 0 10.8 10.8Z" />,
)

export const IconSparkles = icon(
  <>
    <path d="M11 4.2 12.6 9l4.8 1.6-4.8 1.6L11 17l-1.6-4.8L4.6 10.6 9.4 9Z" />
    <path d="M18 3.4v3.2M19.6 5h-3.2" />
  </>,
)

export const IconSend = icon(
  <>
    <path d="M20 4.4 4.6 11.3l6.1 2.3 2.3 6.1Z" />
    <path d="M20 4.4 10.7 13.6" />
  </>,
)

export const IconPlus = icon(<path d="M12 5.4v13.2M5.4 12h13.2" />)

export const IconClose = icon(<path d="M6.6 6.6 17.4 17.4M17.4 6.6 6.6 17.4" />)

export const IconTrash = icon(
  <>
    <path d="M4.8 7.2h14.4" />
    <path d="M9.6 7.2V5.7A1.7 1.7 0 0 1 11.3 4h1.4a1.7 1.7 0 0 1 1.7 1.7v1.5" />
    <path d="M6.6 7.2 7.5 19a1.7 1.7 0 0 0 1.7 1.6h5.6a1.7 1.7 0 0 0 1.7-1.6l.9-11.8" />
    <path d="M10.5 11v6.2M13.5 11v6.2" />
  </>,
)

export const IconEdit = icon(
  <>
    <path d="M4.6 19.4 9 18.5l9.3-9.3a2.3 2.3 0 0 0-3.3-3.3L5.7 15.2Z" />
    <path d="M14.2 6.9l3.2 3.2" />
  </>,
)

export const IconStar = icon(
  <path d="M12 4.4l2.4 4.9 5.4.8-3.9 3.8.9 5.4-4.8-2.5-4.8 2.5.9-5.4-3.9-3.8 5.4-.8Z" />,
)

export const IconCamera = icon(
  <>
    <path d="M4.4 8.8A2.3 2.3 0 0 1 6.7 6.5h1.4l1.2-2h5.4l1.2 2h1.4a2.3 2.3 0 0 1 2.3 2.3v8.4a2.3 2.3 0 0 1-2.3 2.3H6.7a2.3 2.3 0 0 1-2.3-2.3Z" />
    <circle cx="12" cy="13" r="3.3" />
  </>,
)

export const IconImage = icon(
  <>
    <rect x="3.8" y="5" width="16.4" height="14" rx="3.2" />
    <circle cx="9" cy="10" r="1.6" />
    <path d="M4.4 16.8 9.6 12l3 2.6 2.5-2.2 4.5 4" />
  </>,
)

export const IconUpload = icon(
  <>
    <path d="M12 16.4V5.6" />
    <path d="M7.7 9.9 12 5.6l4.3 4.3" />
    <path d="M4.8 15.4v2.8a2.3 2.3 0 0 0 2.3 2.3h9.8a2.3 2.3 0 0 0 2.3-2.3v-2.8" />
  </>,
)

export const IconCheck = icon(<path d="M5 12.6 9.6 17 19 7" />)

export const IconMenu = icon(<path d="M4 7.2h16M4 12h16M4 16.8h16" />)

export const IconDots = icon(
  <>
    <circle cx="5.6" cy="12" r="1.6" fill="currentColor" stroke="none" />
    <circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none" />
    <circle cx="18.4" cy="12" r="1.6" fill="currentColor" stroke="none" />
  </>,
)

export const IconChevronLeft = icon(<path d="M14.6 6 8.6 12l6 6" />)
export const IconChevronRight = icon(<path d="M9.4 6l6 6-6 6" />)
export const IconChevronDown = icon(<path d="M6 9.6l6 6 6-6" />)

export const IconPanel = icon(
  <>
    <rect x="3.6" y="4.4" width="16.8" height="15.2" rx="3.4" />
    <path d="M15 4.4v15.2" />
  </>,
)

export const IconCalendar = icon(
  <>
    <rect x="3.8" y="5.4" width="16.4" height="14.2" rx="3.2" />
    <path d="M3.8 10.2h16.4" />
    <path d="M8.4 3.6v3.6M15.6 3.6v3.6" />
  </>,
)

export const IconClock = icon(
  <>
    <circle cx="12" cy="12" r="8.4" />
    <path d="M12 7.4V12l3 1.9" />
  </>,
)

export const IconRefresh = icon(
  <>
    <path d="M19.6 12a7.6 7.6 0 1 1-2.3-5.5" />
    <path d="M19.9 4.4v4.3h-4.3" />
  </>,
)

export const IconFlame = icon(
  <path d="M12.2 3.6c3.1 3 4.7 5.4 4.7 8.1a4.9 4.9 0 0 1-9.8 0c0-1.2.4-2.3 1.2-3.3.4 1.2 1 1.9 1.9 2.2-.3-2.6.3-4.7 2-7Z" />,
)

export const IconLink = icon(
  <>
    <path d="M14 4.6h5.4V10" />
    <path d="M19.4 4.6 11 13" />
    <path d="M18 14.4v3.9a2.1 2.1 0 0 1-2.1 2.1H6.1A2.1 2.1 0 0 1 4 18.3V8.4a2.1 2.1 0 0 1 2.1-2.1h3.9" />
  </>,
)

export const IconAlert = icon(
  <>
    <circle cx="12" cy="12" r="8.4" />
    <path d="M12 7.8v5" />
    <circle cx="12" cy="16" r="0.9" fill="currentColor" stroke="none" />
  </>,
)

export const IconBug = icon(
  <>
    <rect x="8.2" y="7.6" width="7.6" height="11.4" rx="3.8" />
    <path d="M9.2 7.2a2.8 2.8 0 0 1 5.6 0" />
    <path d="M12 4.4V3" />
    <path d="M8.2 10.8H4.8M8.4 15h-3M15.8 10.8h3.4M15.6 15h3" />
    <path d="M12 10.6v6.4" />
  </>,
)

export const IconLogs = icon(
  <>
    <path d="M14.4 3.4H7.2A1.8 1.8 0 0 0 5.4 5.2v13.6a1.8 1.8 0 0 0 1.8 1.8h3.4" />
    <path d="M14.4 3.4 18.6 7.6v3" />
    <path d="M14.4 3.4v4.2h4.2" />
    <path d="M8.6 12.4h3.2M8.6 15.6h1.8" />
    <circle cx="16.2" cy="16.2" r="3.2" />
    <path d="m18.6 18.6 2.2 2.2" />
  </>,
)

export const IconRequirements = icon(
  <>
    <rect x="5" y="4.8" width="14" height="15.6" rx="3" />
    <path d="M9.2 4.8V4a1.6 1.6 0 0 1 1.6-1.6h2.4A1.6 1.6 0 0 1 14.8 4v0.8" />
    <path d="M8.8 10.6h6.4M8.8 14h6.4M8.8 17.4h3.6" />
  </>,
)

export const IconCode = icon(
  <>
    <path d="M8.4 7.2 3.8 12l4.6 4.8" />
    <path d="M15.6 7.2 20.2 12l-4.6 4.8" />
    <path d="M13.4 5.6l-2.8 12.8" />
  </>,
)

export const IconBook = icon(
  <>
    <path d="M12 7.2C10.4 5.9 8 5.2 5.6 5.2c-.9 0-1.7.1-2.4.3v13c.7-.2 1.5-.3 2.4-.3 2.4 0 4.8.7 6.4 2 1.6-1.3 4-2 6.4-2 .9 0 1.7.1 2.4.3v-13c-.7-.2-1.5-.3-2.4-.3-2.4 0-4.8.7-6.4 2Z" />
    <path d="M12 7.2v13" />
  </>,
)

export const IconSearch = icon(
  <>
    <circle cx="10.8" cy="10.8" r="6.4" />
    <path d="m15.6 15.6 4 4" />
  </>,
)

export const IconSettings = icon(
  <>
    <circle cx="12" cy="12" r="3" />
    <path d="M12 3.4v2.3M12 18.3v2.3M4.9 7.8l2 1.2M17.1 15l2 1.2M4.9 16.2l2-1.2M17.1 9l2-1.2" />
  </>,
)

export const IconSun = icon(
  <>
    <circle cx="12" cy="12" r="4.2" />
    <path d="M12 3.2v2M12 18.8v2M3.2 12h2M18.8 12h2M5.8 5.8l1.4 1.4M16.8 16.8l1.4 1.4M5.8 18.2l1.4-1.4M16.8 7.2l1.4-1.4" />
  </>,
)

export const IconMoon = icon(
  <path d="M20.2 14.6A8.3 8.3 0 0 1 9.4 3.8a8.6 8.6 0 1 0 10.8 10.8Z" />,
)

export const IconTag = icon(
  <>
    <path d="M12.6 3.8H19a1.2 1.2 0 0 1 1.2 1.2v6.4a2 2 0 0 1-.6 1.4l-6.6 6.6a2 2 0 0 1-2.8 0l-5-5a2 2 0 0 1 0-2.8l6.6-6.6a2 2 0 0 1 1.4-.6Z" />
    <circle cx="16.2" cy="7.8" r="1.2" fill="currentColor" stroke="none" />
  </>,
)

export const IconDensity = icon(
  <>
    <path d="M4 7.4h16M4 12h16M4 16.6h16" />
    <path d="M4 7.4v0M4 12v0M4 16.6v0" />
  </>,
)

export const IconCommand = icon(
  <path d="M8.6 4.2a2.6 2.6 0 1 0 2.6 2.6v10.4a2.6 2.6 0 1 0 2.6-2.6H8.6a2.6 2.6 0 1 0 2.6 2.6V6.8a2.6 2.6 0 1 0-2.6-2.6h10.4a2.6 2.6 0 1 0-2.6 2.6Z" />,
)

export const IconPlay = icon(<path d="M8.4 5.6 18 12l-9.6 6.4Z" />)

export const IconInbox = icon(
  <>
    <path d="M4.4 13.4 6 5.6a2 2 0 0 1 2-1.6h8a2 2 0 0 1 2 1.6l1.6 7.8" />
    <path d="M4.4 13.4h4l1 2.4h5.2l1-2.4h4v4.2a2.4 2.4 0 0 1-2.4 2.4H6.8a2.4 2.4 0 0 1-2.4-2.4Z" />
  </>,
)

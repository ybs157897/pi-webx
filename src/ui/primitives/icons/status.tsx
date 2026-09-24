/**
 * Time, telemetry and in-flight state: clocks, gauge, spinner, data shapes.
 * Split out of index.tsx as a mechanical move: glyph bodies are byte-for-byte
 * the originals, and index.tsx re-exports every one of them.
 */

import type { IconProps } from './props.ts'

/** ic_ds_loading_outline_16 */
export const IconLoadingOutline16 = ({ size = 16, className }: IconProps) => (
  <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path
      d="M2.871 13.1286C0.0387669 10.2962 0.0387669 5.70383 2.871 2.87141C5.70341 0.0390029 10.2957 0.0391154 13.1282 2.87141L12.1387 3.86094C9.85292 1.57538 6.1469 1.57596 3.86123 3.86163C1.57573 6.14732 1.57573 9.85269 3.86123 12.1384C6.1469 14.424 9.85292 14.4246 12.1387 12.1391L13.1282 13.1286C10.2957 15.9609 5.70341 15.961 2.871 13.1286Z"
      fill="currentColor"
    />
  </svg>
)

/** ic_ds_followsystem_outline_16 */
export const IconFollowsystemOutline16 = ({ size = 16, className }: IconProps) => (
  <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M12.1665 13.5811V14.7803H3.66651V13.5811H12.1665Z" fill="currentColor" />
    <path
      d="M13.4453 7.02379C13.4453 6.04702 13.4452 5.3616 13.3887 4.83434C13.3333 4.31828 13.2302 4.02378 13.0723 3.80309C12.9446 3.62475 12.7877 3.46883 12.6094 3.34117C12.3887 3.18328 12.0942 3.08007 11.5781 3.02477C11.0508 2.96829 10.3655 2.96715 9.38867 2.96715H6.61035C5.63359 2.96715 4.94816 2.96827 4.4209 3.02477C3.90486 3.0801 3.61034 3.18321 3.38965 3.34117C3.21143 3.46878 3.05534 3.62487 2.92774 3.80309C2.76977 4.02377 2.66667 4.3183 2.61133 4.83434C2.55483 5.3616 2.55371 6.04702 2.55371 7.02379C2.55371 8.0006 2.55485 8.68596 2.61133 9.21324C2.66663 9.72936 2.76983 10.0238 2.92774 10.2445C3.0554 10.4228 3.21131 10.5797 3.38965 10.7074C3.61034 10.8654 3.90484 10.9685 4.4209 11.0238C4.94816 11.0803 5.63359 11.0804 6.61035 11.0804H9.38867C10.3654 11.0804 11.0508 11.0803 11.5781 11.0238C12.0941 10.9685 12.3887 10.8652 12.6094 10.7074C12.7877 10.5797 12.9446 10.4229 13.0723 10.2445C13.2301 10.0238 13.3334 9.72927 13.3887 9.21324C13.4452 8.68596 13.4453 8.00058 13.4453 7.02379ZM14.6455 7.02379C14.6455 7.97428 14.646 8.73509 14.5811 9.34117C14.5149 9.95828 14.3756 10.4858 14.0479 10.9437C13.8436 11.229 13.5938 11.4788 13.3086 11.683C12.8507 12.0108 12.3232 12.15 11.7061 12.2162C11.1 12.2811 10.3391 12.2806 9.38867 12.2806H6.61035C5.66018 12.2806 4.89991 12.2811 4.29395 12.2162C3.67684 12.15 3.14935 12.0108 2.69141 11.683C2.40613 11.4788 2.15639 11.229 1.95215 10.9437C1.62436 10.4858 1.4841 9.95828 1.41797 9.34117C1.35305 8.73511 1.35449 7.97424 1.35449 7.02379C1.35449 6.07366 1.35308 5.31333 1.41797 4.70738C1.4841 4.09028 1.62436 3.56279 1.95215 3.10485C2.15638 2.81956 2.40613 2.56982 2.69141 2.36559C3.14935 2.03779 3.67684 1.89753 4.29395 1.83141C4.8999 1.76652 5.66022 1.76793 6.61035 1.76793H9.38867C10.3391 1.76793 11.1 1.76649 11.7061 1.83141C12.3232 1.89753 12.8507 2.03779 13.3086 2.36559C13.5939 2.56982 13.8436 2.81957 14.0479 3.10485C14.3756 3.56279 14.5149 4.09028 14.5811 4.70738C14.646 5.31335 14.6455 6.07362 14.6455 7.02379Z"
      fill="currentColor"
    />
  </svg>
)

/** ic_ds_data_outline_16 */
export const IconDataOutline16 = ({ size = 16, className }: IconProps) => (
  <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path
      fillRule="evenodd"
      clipRule="evenodd"
      d="M12.0997 8.54554C12.2905 8.54989 12.3541 8.58056 12.4535 8.74614L12.8849 9.46387C12.9851 9.63071 13.0464 9.66013 13.2388 9.66447H14.1138C14.3417 9.66448 14.3512 9.66937 14.4686 9.86507L14.892 10.5717C14.9942 10.7422 14.9948 10.8247 14.892 10.9961L14.4756 11.6906C14.3741 11.8677 14.3694 11.9379 14.4756 12.115L14.892 12.8096C14.9942 12.9801 14.9947 13.0625 14.892 13.234L14.4686 13.9406C14.3643 14.1028 14.3063 14.1354 14.1138 14.1412H13.2388C13.0465 14.1456 12.985 14.1752 12.8849 14.3418L12.4535 15.0595C12.353 15.2195 12.2895 15.2558 12.0997 15.2601H11.2237C10.9962 15.2601 10.9871 15.2548 10.8699 15.0595L10.4384 14.3418C10.3383 14.175 10.2767 14.1456 10.0846 14.1412H9.2096C9.01854 14.1355 8.95761 14.1006 8.85477 13.9406L8.43139 13.234C8.32562 13.0576 8.33148 12.9862 8.43139 12.8096L8.84771 12.115C8.95165 11.9416 8.94659 11.863 8.84771 11.6906L8.43139 10.9961C8.32767 10.8232 8.33411 10.7437 8.43139 10.5717L8.85477 9.86507C8.95447 9.69891 9.01875 9.67017 9.2096 9.66447H10.0846C10.2741 9.66441 10.3414 9.62547 10.4384 9.46387L10.8699 8.74614C10.987 8.55106 10.9963 8.54554 11.2237 8.54554H12.0997ZM11.6612 10.232C11.3326 10.7798 10.8155 11.0948 10.1743 11.106C10.4443 11.61 10.4425 12.1976 10.1743 12.6987C10.803 12.7096 11.3391 13.0359 11.6612 13.5727C11.9855 13.0323 12.5131 12.7098 13.148 12.6987C12.879 12.196 12.8789 11.6086 13.148 11.106C12.5076 11.0948 11.9894 10.7794 11.6612 10.232Z"
      fill="currentColor"
    />
    <path
      fillRule="evenodd"
      clipRule="evenodd"
      d="M7.51205 0.790627C9.19055 0.790649 10.7401 1.0691 11.892 1.54364C12.4664 1.78029 12.9719 2.07885 13.3436 2.4408C13.7171 2.80467 13.9916 3.27253 13.9918 3.82384V7.90442C13.6067 7.69532 13.1907 7.53597 12.7529 7.43366V5.66454C12.4928 5.82898 12.2028 5.97601 11.892 6.10405C10.74 6.57865 9.19071 6.85706 7.51205 6.85706C5.8337 6.85703 4.285 6.57852 3.13309 6.10405C2.82215 5.97593 2.53164 5.8291 2.27121 5.66454V7.4135C2.27134 7.75678 2.6066 8.27106 3.62502 8.73405C4.58641 9.17097 5.95762 9.45591 7.50499 9.45681C7.24582 9.83133 7.03684 10.2434 6.88706 10.6826C5.44388 10.6162 4.12516 10.3216 3.11192 9.86104C2.81708 9.72698 2.53185 9.56866 2.27121 9.38928V11.2542C2.27158 11.5974 2.60697 12.1109 3.62502 12.5737C4.41933 12.9347 5.4937 13.1898 6.71569 13.2693C6.80349 13.7128 6.9513 14.1345 7.14814 14.5273C5.60324 14.4862 4.18593 14.1889 3.11192 13.7007C2.01039 13.1998 1.03366 12.3814 1.03333 11.2542V3.82384C1.03352 3.27273 1.30721 2.80461 1.68049 2.4408C2.05211 2.07893 2.55887 1.78026 3.13309 1.54364C4.28492 1.06926 5.83393 0.790683 7.51205 0.790627ZM7.51205 2.02851C5.95492 2.02857 4.57354 2.29079 3.60486 2.68979C3.11958 2.88977 2.76667 3.11253 2.5454 3.32788C2.32671 3.54101 2.2714 3.7089 2.27121 3.82384C2.27121 3.93882 2.32624 4.10625 2.5454 4.3198C2.76667 4.53527 3.11927 4.75781 3.60486 4.9579C4.5736 5.35699 5.95467 5.61914 7.51205 5.61918C9.06942 5.61918 10.4505 5.35695 11.4192 4.9579C11.9051 4.75773 12.2584 4.53536 12.4797 4.3198C12.6988 4.10627 12.7529 3.93882 12.7529 3.82384C12.7527 3.70889 12.6984 3.54104 12.4797 3.32788C12.2584 3.11239 11.9049 2.88989 11.4192 2.68979C10.4505 2.29079 9.06925 2.02853 7.51205 2.02851Z"
      fill="currentColor"
    />
  </svg>
)

/** IconDataOutline16 without its gear: a three-tier database cylinder. */
export const IconDatabaseOutline16 = ({ size = 16, className }: IconProps) => (
  <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
    <ellipse cx="8" cy="3.6" rx="5.75" ry="2.4" stroke="currentColor" strokeWidth="1.25" />
    <path d="M2.25 3.6V12.3A5.75 2.4 0 0 0 13.75 12.3V3.6" stroke="currentColor" strokeWidth="1.25" />
    <path d="M2.25 7.95A5.75 2.4 0 0 0 13.75 7.95" stroke="currentColor" strokeWidth="1.25" />
  </svg>
)

/** Thin-stroke clock: outlined dial with square-cut hour and minute hands. */
export const IconClockOutline16 = ({ size = 16, className }: IconProps) => (
  <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
    <circle cx="8" cy="8" r="6.375" stroke="currentColor" strokeWidth="1.25" />
    <path d="M8 4.4V8.3L10.7 9.85" stroke="currentColor" strokeWidth="1.25" />
  </svg>
)

/** Thin-stroke gauge: dial arc open at the bottom, filled hub, square-cut needle to the upper right.
 * The dial center sits at y=8.75, not 8: the bottom opening leaves the glyph top-heavy, and the
 * 0.75 drop optically centers the drawn extent in the 16 box. */
export const IconGaugeOutline16 = ({ size = 16, className }: IconProps) => (
  <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M3.49 13.26A6.375 6.375 0 1 1 12.51 13.26" stroke="currentColor" strokeWidth="1.25" />
    <path d="M8 8.75L11.4 5.35" stroke="currentColor" strokeWidth="1.25" />
    <circle cx="8" cy="8.75" r="1.55" fill="currentColor" />
  </svg>
)

/** ic_ds_goal_outline_16 (goal strip leading glyph: dartboard with a landed arrow) */
export const IconGoalOutline16 = ({ size = 16, className }: IconProps) => (
  <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path
      d="M8 0C8.31451 0 8.62464 0.019379 8.92969 0.0546875C8.48228 0.403371 8.0952 0.825758 7.78809 1.30469C4.18586 1.41664 1.2998 4.37061 1.2998 8C1.2998 11.7003 4.29969 14.7002 8 14.7002C11.6297 14.7002 14.5829 11.8136 14.6943 8.21094C15.1734 7.90377 15.5956 7.51688 15.9443 7.06934C15.9797 7.37473 16 7.68512 16 8C16 12.4183 12.4183 16 8 16C3.58172 16 0 12.4183 0 8C0 3.58172 3.58172 0 8 0ZM7.0166 3.6084C7.00658 3.73765 7 3.86817 7 4C7 4.31845 7.03098 4.62973 7.08789 4.93164C5.76489 5.32438 4.7998 6.54958 4.7998 8C4.7998 9.76731 6.23269 11.2002 8 11.2002C9.45065 11.2002 10.6749 10.2345 11.0674 8.91113C11.3696 8.96818 11.6812 9 12 9C12.1315 9 12.2617 8.99239 12.3906 8.98242C11.9423 10.995 10.1477 12.5 8 12.5C5.51472 12.5 3.5 10.4853 3.5 8C3.5 5.85255 5.00435 4.05702 7.0166 3.6084Z"
      fill="currentColor"
    />
    <path d="M7.5 8.62109L9.12109 7" stroke="currentColor" strokeWidth="1.3" />
    <path
      d="M9.08245 3.35798L11.8651 0.575334C11.895 0.545384 11.9463 0.56391 11.9502 0.606086L12.2362 3.69859C12.2384 3.72259 12.2574 3.74159 12.2814 3.74378L15.3697 4.02583C15.4119 4.02968 15.4305 4.08101 15.4005 4.11098L12.618 6.89351C12.6086 6.90289 12.5959 6.90816 12.5826 6.90816L9.11781 6.90815C9.09019 6.90816 9.06781 6.88577 9.06781 6.85816L9.06781 3.39333C9.06781 3.38007 9.07308 3.36735 9.08245 3.35798Z"
      stroke="currentColor"
      strokeWidth="1.3"
    />
  </svg>
)

/** Alarm clock outline for active scheduled-task indicators. */
export const IconAlarmClockOutline16 = ({ size = 16, className }: IconProps) => (
  <svg
    aria-hidden="true"
    width={size}
    height={size}
    className={className}
    viewBox="0 0 16 16"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
  >
    <path d="M3.5 2.5 1.75 4" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
    <path d="M12.5 2.5 14.25 4" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
    <circle cx="8" cy="8.5" r="4.75" stroke="currentColor" strokeWidth="1.25" />
    <path d="M8 5.75V8.5L10 9.75" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />
    <path d="m4.75 12.25-1 1.5" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
    <path d="m11.25 12.25 1 1.5" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
  </svg>
)

/**
 * Compact row glyph of the composer menu: the composer's context-usage ring
 * (ContextMeter) frozen at its resting look — a quiet track with one filled
 * quarter arc. A restyle of the live ring revisits this copy.
 */
export const IconCompactOutline16 = ({ size = 16, className }: IconProps) => (
  <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
    <circle cx="8" cy="8" r="6.4" stroke="currentColor" strokeWidth="1.6" opacity="0.35" />
    <path d="M8 1.6A6.4 6.4 0 0 1 14.4 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
  </svg>
)

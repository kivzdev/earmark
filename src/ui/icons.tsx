// Phosphor's filled icons at the control box's 14 px (kivz.dev's own rail icons are its Figma drawings; everything
// else in Kivz's projects comes from Phosphor until their own set is drawn), plus Earmark's mark.
export {
  ArrowBendUpLeft as BackIcon,
  ArrowRight as NextIcon,
  ArrowSquareOut as OutIcon,
  ChatCircleText as PhrasesIcon,
  Fingerprint as PasskeyIcon,
  FilmStrip as MomentsIcon,
  GearSix as SettingsIcon,
  House as HomeIcon,
  Pause as PauseIcon,
  Play as PlayIcon,
  Plus as PlusIcon,
  Repeat as LoopIcon,
  SignOut as SignOutIcon,
  Star as StarIcon,
  X as RemoveIcon,
} from '@phosphor-icons/react'

/** Earmark's mark: a bookmark ribbon in the mascot's yellow (scripts/icons.py draws the same shape as PNGs) */
export const Mark = () => (
  <svg viewBox="0 0 20 20" aria-hidden>
    <path fill="var(--mascot)" d="M4.4 3.6a2 2 0 0 1 2-2h7.2a2 2 0 0 1 2 2v15.2L10 14.8l-5.6 4Z" />
  </svg>
)

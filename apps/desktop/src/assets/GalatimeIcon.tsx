import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import CommonImage from '../components/common/CommonImage';

// Checked-in UI glyphs, hashed by Vite at build time (or inlined as data URIs when small).
import arrowRightUrl from './images/ui/outline/arrow.svg';
import musicNoteUrl from './images/ui/outline/music_note.svg';
import folderUrl from './images/ui/outline/folder.svg';
import unknownUrl from './images/ui/outline/unknown.svg';
import addUrl from './images/ui/outline/add.svg';
import closeUrl from './images/ui/outline/close.svg';
import controlUrl from './images/ui/outline/control.svg';
import editUrl from './images/ui/outline/edit.svg';
import fitUrl from './images/ui/outline/fit.svg';
import removeUrl from './images/ui/outline/remove.svg';
import selectorUrl from './images/ui/outline/selector.svg';
import trashUrl from './images/ui/outline/trash.svg';
import chevronUrl from './images/ui/outline/chevron.svg';
import switchOnUrl from './images/ui/outline/switch_on.svg';
import switchOffUrl from './images/ui/outline/switch_off.svg';
import loadingUrl from './images/ui/outline/loading.svg';
import gtStudioSvgUrl from './images/gt-studio.svg';
import defendUrl from './images/combat/extra/defend.svg';
import restUrl from './images/combat/extra/rest.svg';
import weaponUrl from './images/combat/extra/weapon.svg';
import inventoryUrl from './images/combat/extra/inventory.svg';
import changeUrl from './images/combat/extra/change.svg';

// Element orbs, from `src/assets/images/combat/elements/` — the vector set that replaced the
// old `public/images/elements/*.png` sprites (now deleted), so combat renders vectors everywhere.
//
// The folder is discovered with `import.meta.glob` instead of one import per file: publishing a
// new element is just dropping an `<element id>.svg` in there — no code edit, no registry to
// keep in sync, exactly the discipline the runtime-built paths had. Vite re-scans the glob when
// the dev server reloads and on every build, and each file still flows through the module graph
// (hashed or inlined like the direct imports above), so it cannot drift off the build.
// The unknown orb is a fixed, always-present fallback, imported directly.
import elementUnknownUrl from './images/combat/elements/unknown.svg';

/** Every scanned element orb, keyed by the path Vite matched (`…/elements/aqua.svg`). */
const COMBAT_ELEMENT_RESOURCES = import.meta.glob<string>('./images/combat/elements/*.svg', {
  eager: true,
  query: '?url',
  import: 'default',
});

/**
 * URL of the orb of an element id, or `undefined` when the folder has no sprite for it (the
 * caller decides what to show instead — {@link ElementIcon} falls back to the unknown orb).
 */
function combatElementResource(elementId: string): string | undefined {
  return COMBAT_ELEMENT_RESOURCES[`./images/combat/elements/${elementId}.svg`];
}

/**
 * The unknown-element orb, exported for any sprite that has none of its own: the same glyph the
 * old `/images/elements/unknown.png` string constant pointed at, now hashed by Vite.
 */
export const UNKNOWN_ELEMENT_ICON: string = elementUnknownUrl;

/**
 * URL of the GT Studio logo (`src/assets/images/gt-studio.svg`), hashed by Vite. It replaced the
 * `public/GT_Team_logo.png`, which was the same square art rasterised at 3100×3100.
 */
export const gtStudioLogoUrl: string = gtStudioSvgUrl;

// --- App Icon (Genérico) ---
interface AppIconProps {
  src: string;
  alt?: string;
  className?: string;
}

export const AppIcon: React.FC<AppIconProps> = ({ src, alt = '', className = '' }) => (
  <CommonImage
    src={src}
    alt={alt}
    fallbackSrc={UNKNOWN_ELEMENT_ICON}
    className={`object-contain ${className}`}
  />
);

// --- Mask Icon (shared glyph renderer) ---
interface MaskIconProps {
  className?: string;
  /** Size box classes, so an icon can default to a size relative to the text it sits in. */
  sizeClass?: string;
  /** Rotation in degrees; used when one SVG stands in for several orientations. */
  rotate?: number;
}

/**
 * Renders one of the SVGs imported above as a CSS mask, filled with `currentColor` so it
 * follows the tone of whatever renders it.
 *
 * The `src` is the Vite-resolved URL of an imported `.svg`, so production builds get hashed
 * filenames (or an inlined data URI) while a dev server keeps a dev URL — either way the icon
 * cannot drift from the module graph the way a hand-typed `public/` path could.
 *
 * Like {@link ArrowRight}'s old glyph, icons are sized in `em` by default (the `em`-based size
 * classes beat a plain `text-*` font-size; pass `h-*`/`w-*` classes to force concrete sizes).
 */
const MaskIcon: React.FC<MaskIconProps & { src: string }> = ({ src, sizeClass = 'h-[1em] w-[1em]', className = '', rotate = 0 }) => (
  <span
    aria-hidden="true"
    className={`block ${sizeClass} bg-current ${className}`}
    style={{
      // The URL must stay quoted: inlined SVG assets arrive as data URIs containing raw
      // `'` characters (the inline derives from the file, where `"` was swapped for `'`),
      // and an unquoted `url(…)` token rejects them — the browser would drop the whole
      // declaration and the icon would render as a plain block of `bg-current`.
      maskImage: `url("${src}")`,
      WebkitMaskImage: `url("${src}")`,
      maskRepeat: 'no-repeat',
      WebkitMaskRepeat: 'no-repeat',
      maskPosition: 'center',
      WebkitMaskPosition: 'center',
      maskSize: 'contain',
      WebkitMaskSize: 'contain',
      transform: rotate ? `rotate(${rotate}deg)` : undefined,
    }}
  />
);

// --- Chevron Icons ---
interface ChevronIconProps {
  className?: string;
}

/**
 * The chevron from `src/assets/images/ui/outline/chevron.svg` points right in the source art, so
 * the left variant is the same glyph rotated a half turn.
 */
export const ChevronRight: React.FC<ChevronIconProps> = ({ className = '' }) => (
  <MaskIcon src={chevronUrl} sizeClass="h-[0.8em] w-[0.8em]" className={className} />
);

export const ChevronLeft: React.FC<ChevronIconProps> = ({ className = '' }) => (
  <MaskIcon src={chevronUrl} sizeClass="h-[0.8em] w-[0.8em]" className={className} rotate={180} />
);

// --- Arrow Icons ---
interface ArrowIconProps {
  className?: string;
}

/**
 * One arrow from `src/assets/images/ui/outline/arrow.svg`, applied as a CSS mask and filled with
 * `currentColor` so it follows the tone of whatever renders it.
 *
 * It is sized in `em`, so the font-size of the surrounding text decides how big it is — pass a
 * `text-*` class to the wrapper rather than a `h-*`/`w-*` one (an arbitrary `[0.8em]` height
 * beats a plain Tailwind size, the same trap `MaskIcon` documents).
 */
export const ArrowRight: React.FC<ArrowIconProps> = ({ className = '' }) => <MaskIcon src={arrowRightUrl} sizeClass="h-[0.8em] w-[0.8em]" className={className} />;

/** Used to mark a statistic a status effect has raised. */
export const ArrowUp: React.FC<ArrowIconProps> = ({ className = '' }) => <MaskIcon src={arrowRightUrl} sizeClass="h-[0.8em] w-[0.8em]" className={className} rotate={-90} />;

/** Used to mark a statistic a status effect has lowered. */
export const ArrowDown: React.FC<ArrowIconProps> = ({ className = '' }) => <MaskIcon src={arrowRightUrl} sizeClass="h-[0.8em] w-[0.8em]" className={className} rotate={90} />;

// --- Switch Icon ---
interface SwitchIconProps {
  checked: boolean;
  className?: string;
}

/**
 * The whooshed toggle glyph from `src/assets/images/ui/outline/switch_on.svg` /
 * `switch_off.svg`, masked so it follows `currentColor` like the other outline icons. The source
 * art is 14×7, so the size box keeps that 2:1 ratio.
 */
export const SwitchIcon: React.FC<SwitchIconProps> = ({ checked, className = '' }) => (
  <MaskIcon
    src={checked ? switchOnUrl : switchOffUrl}
    sizeClass="h-[0.55em] w-[1.1em]"
    className={className}
  />
);

// --- Music Note Icon ---
interface MusicNoteIconProps {
  className?: string;
}

/**
 * Music note from `src/assets/images/ui/outline/music_note.svg`, used by the "now playing" card.
 *
 * The file paints its own path white, so it is applied as a CSS mask by {@link MaskIcon} and
 * filled with `currentColor` instead of being embedded with `<img>`: that keeps it following the
 * accent tone of whatever renders it.
 */
export const MusicNote: React.FC<MusicNoteIconProps> = ({ className = '' }) => (
  <MaskIcon src={musicNoteUrl} sizeClass="h-[0.9em] w-[0.9em]" className={className} />
);

// --- Folder Icon ---
interface FolderIconProps {
  className?: string;
}

/**
 * Folder from `src/assets/images/ui/outline/folder.svg`, used by the Settings header to open the
 * folder that stores `settings.json`.
 *
 * Like {@link MusicNote}, the file paints its own path white, so {@link MaskIcon} applies it as
 * a CSS mask filled with `currentColor` instead of embedding it with `<img>`: that keeps it
 * following the accent tone of whatever renders it.
 *
 * The default size is deliberately small and relative (`em`), so the icon scales with the text
 * it sits next to while staying a quiet accent rather than a second focal point. Pass a
 * `h-*`/`w-*` class to resize it for other uses.
 */
export const FolderIcon: React.FC<FolderIconProps> = ({ className = '' }) => (
  <MaskIcon src={folderUrl} sizeClass="h-[0.4em] w-[0.4em]" className={className} />
);

// --- Unknown Icon ---
interface UnknownIconProps {
  className?: string;
}

/**
 * Question mark from `src/assets/images/ui/outline/unknown.svg`, shown wherever an entity has no
 * sprite of its own.
 *
 * Like {@link MusicNote}, the file paints its own path white, so {@link MaskIcon} applies it as
 * a CSS mask filled with `currentColor` instead of embedding it with `<img>`: that keeps it
 * following the tone of whatever renders it. Pass a `h-*`/`w-*` class to size it.
 */
export const UnknownIcon: React.FC<UnknownIconProps> = ({ className = '' }) => (
  <MaskIcon src={unknownUrl} className={className} />
);

// --- Misc UI icons (imported from src/assets/images/ui/outline) ---
interface MiscIconProps {
  className?: string;
}

export const AddIcon: React.FC<MiscIconProps> = ({ className = '' }) => <MaskIcon src={addUrl} className={className} />;
export const ControlIcon: React.FC<MiscIconProps> = ({ className = '' }) => <MaskIcon src={controlUrl} className={className} />;
export const EditIcon: React.FC<MiscIconProps> = ({ className = '' }) => <MaskIcon src={editUrl} className={className} />;
export const RemoveIcon: React.FC<MiscIconProps> = ({ className = '' }) => <MaskIcon src={removeUrl} className={className} />;
export const TrashIcon: React.FC<MiscIconProps> = ({ className = '' }) => <MaskIcon src={trashUrl} className={className} />;
export const CloseIcon: React.FC<MiscIconProps> = ({ className = '' }) => <MaskIcon src={closeUrl} className={className} />;
export const FitIcon: React.FC<MiscIconProps> = ({ className = '' }) => <MaskIcon src={fitUrl} className={className} />;
export const SelectorIcon: React.FC<MiscIconProps> = ({ className = '' }) => <MaskIcon src={selectorUrl} className={className} />;

// --- Element Icon ---
interface ElementIconProps {
  id: string;
  className?: string;
}

/**
 * The element's orb from `src/assets/images/combat/elements/`, hashed by Vite.
 *
 * The orb is discovered by scanning the folder (`import.meta.glob`), so an unregistered element —
 * or one whose SVG has not been authored yet — falls back to the unknown orb rather than waiting
 * for a load failure. Authoring a new element's orb needs no code change: the file name's stem
 * (`<element id>.svg`) is the id `ElementIcon` looks up.
 */
export const ElementIcon: React.FC<ElementIconProps> = ({ id, className = '' }) => (
  <CommonImage
    src={combatElementResource(id) ?? elementUnknownUrl}
    alt={id}
    fallbackSrc={elementUnknownUrl}
    className={`object-contain ${className}`}
  />
);

// --- Combat Extra Movement Icons ---
interface CombatIconProps {
  className?: string;
}

export const DefendIcon: React.FC<CombatIconProps> = ({ className = '' }) => <MaskIcon src={defendUrl} className={className} />;
export const RestIcon: React.FC<CombatIconProps> = ({ className = '' }) => <MaskIcon src={restUrl} className={className} />;
export const WeaponIcon: React.FC<CombatIconProps> = ({ className = '' }) => <MaskIcon src={weaponUrl} className={className} />;
export const InventoryIcon: React.FC<CombatIconProps> = ({ className = '' }) => <MaskIcon src={inventoryUrl} className={className} />;
export const ChangeIcon: React.FC<CombatIconProps> = ({ className = '' }) => <MaskIcon src={changeUrl} className={className} />;

// --- Loading Component ---
interface LoadingProps {
  images?: string[];
  interval?: number;
  loadingText?: string;
  subtext?: string;
  containerClassName?: string;
  textClassName?: string;
  imageClassName?: string;
  subtextClassName?: string;
}

const DEFAULT_LOADING_IMAGES: string[] = [loadingUrl];

export const Loading: React.FC<LoadingProps> = ({
  images = DEFAULT_LOADING_IMAGES,
  interval = 500,
  loadingText,
  subtext,
  containerClassName = '',
  textClassName = '',
  imageClassName = '',
  subtextClassName = '',
}) => {
  const { t } = useTranslation('common');
  const [currentIndex, setCurrentIndex] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => {
      setCurrentIndex((prevIndex) => (prevIndex + 1) % images.length);
    }, interval);

    return () => clearInterval(timer);
  }, [images.length, interval]);

  const displayText = loadingText ? t(loadingText) : null;
  const altText = t('loading.alt');

  return (
    <div
      className={`flex flex-col items-center justify-center select-none ${containerClassName}`}
    >
      <div className="flex items-center justify-center">
        <CommonImage
          src={images[currentIndex]}
          alt={altText}
          className={`h-12 w-auto transition-all duration-75 ${imageClassName}`}
        />
      </div>

      {displayText && (
        <h1 className={`font-pixel text-xl animate-pulse ${textClassName}`}>
          {displayText}
        </h1>
      )}

      {subtext && (
        <div className={`mt-4 text-lg text-center max-w-md px-4 ${subtextClassName}`}>
          {subtext}
        </div>
      )}
    </div>
  );
};

import { load } from 'js-yaml';
import type { AudioTrackDefinition, AudioVolumes } from '../types/AudioType';

import musicYamlRaw from '../data/audio/music.yaml?raw';
import sfxYamlRaw from '../data/audio/sfx.yaml?raw';
import ambientYamlRaw from '../data/audio/ambient.yaml?raw';

// Every audio file is discovered by path, so publishing a track is just dropping the file in
// `src/assets/` and adding an entry to the YAML. `eager` is required: the resolver below is
// synchronous, and without it each entry would be a lazy `() => import(...)` loader instead of
// the hashed URL string the players are built from. Vite hashes these URLs at build time, so the
// built app references the emitted assets rather than a source-tree path.
const audioModules = import.meta.glob<string>('../assets/**/*.{ogg,mp3,wav}', {
    eager: true,
    query: '?url',
    import: 'default',
});

/**
 * URL of every audio file, keyed by its path inside `src/assets/` (`music/<track>.ogg`,
 * `sounds/<sfx>.ogg`).
 *
 * The YAML files spell tracks as `../assets/music/<track>.ogg`, while the glob keys them as
 * `../assets/music/<track>.ogg` too. Normalising both sides to the suffix after `assets/`
 * keeps the lookup from depending on the prefix each file happens to use.
 */
const audioUrls = new Map<string, string>(
    Object.entries(audioModules).map(([key, url]) => [toAssetKey(key), url]),
);

function toAssetKey(path: string): string {
    return path.replace(/\\/g, '/').replace(/^.*\/assets\//, '');
}

function resolveAudioPath(yamlPath: string): string {
    const url = audioUrls.get(toAssetKey(yamlPath));

    if (!url) {
        // A missing file would otherwise surface as a silent `Audio` load error at runtime.
        console.warn(`Audio file not found in src/assets: ${yamlPath}`);
        return yamlPath;
    }

    return url;
}

function loadAudioTracksFromYaml(yamlContent: string): AudioTrackDefinition[] {
    try {
        const parsed = load(yamlContent);
        if (!Array.isArray(parsed)) {
            return [];
        }
        return parsed.map((item: any) => ({
            id: item.id,
            src: resolveAudioPath(item.src),
            // YAML tracks declare their display name as `name`; `title` is kept as an alias.
            title: item.title ?? item.name,
            description: item.description,
            loop: item.loop ?? false,
        }));
    } catch {
        return [];
    }
}

export const MUSIC_TRACKS: AudioTrackDefinition[] = loadAudioTracksFromYaml(musicYamlRaw);
export const SFX_TRACKS: AudioTrackDefinition[] = loadAudioTracksFromYaml(sfxYamlRaw);
export const AMBIENT_TRACKS: AudioTrackDefinition[] = loadAudioTracksFromYaml(ambientYamlRaw);

export const DEFAULT_MUSIC_TRACK_ID = MUSIC_TRACKS[0]?.id ?? 'galatime_theme';
export const BUTTON_SFX_ID = 'hover';

export const DEFAULT_AUDIO_VOLUMES: AudioVolumes = {
    master: 80,
    music: 80,
    sfx: 80,
    ambient: 80,
};
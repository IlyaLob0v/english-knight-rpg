import type { ContentBundle, Course, Episode, MoonbridgeContent, Place } from "@moonbridge/content";

/** What Moonbridge keeps for a student. Answers and errors live in the shared journal, not here. */
export interface MoonbridgeState {
  version: 1;
  completed_episodes: string[];
}

export function emptyState(): MoonbridgeState {
  return { version: 1, completed_episodes: [] };
}

/** Accepts a stored state of any age; unknown shapes start fresh rather than break the section. */
export function migrateState(raw: unknown): MoonbridgeState {
  const r = raw as Partial<MoonbridgeState> | undefined;
  if (r?.version === 1 && Array.isArray(r.completed_episodes)) return { version: 1, completed_episodes: r.completed_episodes.filter((e) => typeof e === "string") };
  return emptyState();
}

export function completeEpisode(state: MoonbridgeState, episodeId: string): MoonbridgeState {
  if (state.completed_episodes.includes(episodeId)) return state;
  return { ...state, completed_episodes: [...state.completed_episodes, episodeId] };
}

export interface EpisodeView {
  episode: Episode;
  done: boolean;
  /** The episode's unit has been reached in the course. */
  available: boolean;
}

export interface PlaceView {
  place: Place;
  open: boolean;
  episodes: EpisodeView[];
}

export interface HotelView {
  course: Course;
  /** The unit the student is on: the first one in course order with an episode not yet played. Undefined when all are done. */
  currentUnit: string | undefined;
  places: PlaceView[];
  /** What the "Play" button on the map starts: the first available episode not yet played. */
  next: Episode | undefined;
}

/**
 * The hotel as the student sees it. Until the platform tracks lessons (week 5), the course
 * advances through Moonbridge itself: a unit is behind the student once all its episodes are
 * played, and units without episodes do not hold anyone back. A place opens when the student
 * reaches the unit that unlocks it; the validator guarantees that is never later than its episodes.
 */
export function hotelView(content: MoonbridgeContent, course: Course, state: MoonbridgeState): HotelView {
  const done = new Set(state.completed_episodes);
  const position = new Map(course.units.map((u, i) => [u, i]));
  const inCourse = content.episodes.filter((e) => position.has(e.module_id));
  const pending = inCourse.filter((e) => !done.has(e.episode_id)).map((e) => position.get(e.module_id)!);
  const currentPos = pending.length ? Math.min(...pending) : course.units.length;
  const reached = (unit: string | null) => unit === null || (position.get(unit) ?? Infinity) <= currentPos;

  // Map order: open-from-the-start places first, then in the order the course opens them.
  const opensAt = (p: Place) => (p.unlocked_by === null ? -1 : (position.get(p.unlocked_by) ?? Number.MAX_SAFE_INTEGER));
  const places = [...content.places].sort((a, b) => opensAt(a) - opensAt(b)).map((place) => ({
    place,
    open: reached(place.unlocked_by),
    episodes: inCourse
      .filter((e) => e.place_id === place.place_id)
      .sort((a, b) => position.get(a.module_id)! - position.get(b.module_id)!)
      .map((episode) => ({ episode, done: done.has(episode.episode_id), available: reached(episode.module_id) })),
  }));
  const next = places
    .filter((p) => p.open)
    .flatMap((p) => p.episodes)
    .filter((e) => e.available && !e.done)
    .sort((a, b) => position.get(a.episode.module_id)! - position.get(b.episode.module_id)!)[0]?.episode;
  return { course, currentUnit: course.units[currentPos], places, next };
}

/** The course the student is on. One course until groups arrive (week 5). */
export function studentCourse(bundle: ContentBundle, courseId?: string): Course | undefined {
  return courseId ? bundle.courses.find((c) => c.course_id === courseId) : bundle.courses[0];
}

export type FrameCount = 24 | 48;
export type PhotoGroup = 'exterior' | 'inspection' | 'extra';
export interface CaptureSlot { id: string; title: string; group: PhotoGroup; angle?: number; instruction: string }
export interface CarDetails {
  make: string; model: string; year: string; trim: string; mileage: string;
  price: string; currency: string; location: string; transmission: string;
  fuel: string; color: string; description: string; whatsapp?: string;
}
export interface Project {
  id: string; createdAt: string; updatedAt: string; frameCount: FrameCount;
  details: CarDetails;
  slug?: string;
  status?: 'draft' | 'published' | 'deleting';
}
export interface OriginalPhoto {
  id: string; projectId: string; slotId: string; original: Blob;
  filename: string; mime: string; bytes: number; uploadedAt: string;
  previewSupported: boolean;
  remotePreview?: string;
  remoteThumbnail?: string;
  remoteOriginal?: string;
  /** Separate, compatible source used only to generate a preview; never replaces original bytes. */
  previewSource?: Blob;
}
// A cloud adapter should implement this boundary with private object storage and authorized URLs.
export interface ShowroomRepository {
  listProjects(): Promise<Project[]>;
  saveProject(project: Project): Promise<void>;
  deleteProject(id: string): Promise<void>;
  getPhotos(projectId: string): Promise<OriginalPhoto[]>;
  savePhoto(photo: OriginalPhoto): Promise<void>;
  deletePhoto(id: string): Promise<void>;
}
export interface PublishingService { publish(projectId: string): Promise<{ publicUrl: string }>; unpublish(projectId: string): Promise<void> }
export interface AuthUser { id: string; email: string }
// Implement with Supabase Auth later; never persist passwords in the draft repository.
export interface AuthService {
  currentUser(): Promise<AuthUser | null>;
  signIn(email: string, password: string): Promise<AuthUser>;
  register(email: string, password: string, name: string): Promise<{ user: AuthUser | null; confirmationRequired: boolean }>;
  signOut(): Promise<void>;
  requestPasswordReset(email: string): Promise<void>;
}
export const EMPTY_DETAILS: CarDetails = {
  make: '', model: '', year: '', trim: '', mileage: '', price: '', currency: 'PKR',
  location: '', transmission: 'Automatic', fuel: 'Petrol', color: '', description: '',
};
export const CONFIG = { brand: 'Auto360', defaultFrames: 24 as FrameCount, maxFileBytes: 100 * 1024 * 1024 };
export const INSPECTIONS: CaptureSlot[] = [
  { id: 'engine', title: 'Bonnet & engine', group: 'inspection', instruction: 'Park safely, switch off the engine and let it cool. Open the bonnet and frame the entire engine bay.' },
  { id: 'trunk', title: 'Trunk / boot', group: 'inspection', instruction: 'Open the boot. Photograph the full cargo area in even light, including the floor and side walls.' },
  { id: 'front-interior', title: 'Front interior', group: 'inspection', instruction: 'From an open front door, include both front seats, the dashboard and center console.' },
  { id: 'rear-interior', title: 'Rear interior', group: 'inspection', instruction: 'From an open rear door, frame the rear seats, footwell and door trim.' },
  { id: 'odometer', title: 'Odometer', group: 'inspection', instruction: 'With the car stationary, photograph the mileage display straight on. Keep the digits readable and avoid glare.' },
  { id: 'wheel', title: 'Wheel & tyre', group: 'inspection', instruction: 'Frame a complete wheel and tyre sidewall, then use extra photos for tread wear or damage.' },
];
export const EXTRAS: CaptureSlot[] = [
  ['scratches', 'Scratches & damage'], ['paint', 'Paint condition'],
  ['door-fl', 'Front-left door'], ['door-fr', 'Front-right door'],
  ['door-rl', 'Rear-left door'], ['door-rr', 'Rear-right door'],
  ['service', 'Service history'], ['other', 'Other details'],
].map(([id, title]) => ({ id, title, group: 'extra', instruction: 'Use natural light and show the detail clearly. For documents, cover personal information before taking the photograph.' }));
export function position(angle: number): string {
  if (angle === 0) return 'Straight front';
  if (angle < 90) return 'Front-left quarter';
  if (angle === 90) return 'Left side';
  if (angle < 180) return 'Rear-left quarter';
  if (angle === 180) return 'Straight rear';
  if (angle < 270) return 'Rear-right quarter';
  if (angle === 270) return 'Right side';
  return 'Front-right quarter';
}
export function slots(count: FrameCount): CaptureSlot[] {
  return [...Array.from({ length: count }, (_, index) => {
    const angle = index * 360 / count;
    return { id: `ext-${angle}`, title: position(angle), group: 'exterior' as const, angle,
      instruction: 'Start about 3–5 metres away; adjust until the whole car fits with space around both bumpers. Use even daylight, avoid glare and keep the camera at headlight height. Keep the same distance and level horizon as you move clockwise.' };
  }), ...INSPECTIONS, ...EXTRAS];
}
export function title(project: Project): string { return [project.details.year, project.details.make, project.details.model].filter(Boolean).join(' ') || 'Untitled showroom'; }
export function photoKey(projectId: string, slotId: string): string { return `${projectId}:${slotId}`; }

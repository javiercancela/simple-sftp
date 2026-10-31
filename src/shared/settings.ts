import { z } from 'zod';

export const SETTINGS_FILE_VERSION = 1;
export const SIDEBAR_MIN = 180;
export const SIDEBAR_MAX = 480;

export const ThemeSchema = z.enum(['system', 'light', 'dark']);
export type Theme = z.infer<typeof ThemeSchema>;

export const WindowStateSchema = z
  .object({
    x: z.number().int().optional(),
    y: z.number().int().optional(),
    width: z.number().int().min(400).max(20000),
    height: z.number().int().min(300).max(20000),
    maximized: z.boolean(),
  })
  .strict();
export type WindowState = z.infer<typeof WindowStateSchema>;

export const SettingsSchema = z
  .object({
    version: z.literal(SETTINGS_FILE_VERSION),
    theme: ThemeSchema,
    sidebarWidth: z.number().int().min(SIDEBAR_MIN).max(SIDEBAR_MAX),
    lastSelectedProfileId: z.uuid().nullable(),
    window: WindowStateSchema.nullable(),
  })
  .strict();
export type Settings = z.infer<typeof SettingsSchema>;

export const DEFAULT_SETTINGS: Settings = {
  version: SETTINGS_FILE_VERSION,
  theme: 'system',
  sidebarWidth: 260,
  lastSelectedProfileId: null,
  window: null,
};

/** What the renderer may change. */
export const SettingsPatchSchema = z
  .object({
    theme: ThemeSchema.optional(),
    sidebarWidth: z.number().int().min(SIDEBAR_MIN).max(SIDEBAR_MAX).optional(),
    lastSelectedProfileId: z.uuid().nullable().optional(),
  })
  .strict();
export type SettingsPatch = z.infer<typeof SettingsPatchSchema>;

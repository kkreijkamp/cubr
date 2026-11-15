// Imported first by main.tsx, so the old-name keys are moved before any module reads storage.
import { browserLocalStorage, migrateLegacyStorage } from './legacyStorage';

migrateLegacyStorage(browserLocalStorage());

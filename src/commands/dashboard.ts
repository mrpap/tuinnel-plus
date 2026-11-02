import { getToken } from '../config/store.js';
import { launchTui } from '../tui/launch.js';

export async function openDashboard(): Promise<void> {
  let token: string | null = null;
  try {
    token = getToken();
  } catch {
    // No token — will show onboarding
  }

  await launchTui({ initialMode: token ? undefined : 'onboarding' });
}

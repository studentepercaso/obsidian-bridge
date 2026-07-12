export type ActivationOutcome =
  | Readonly<{ activated: false; activationError: unknown }>
  | Readonly<{ activated: true; uiError?: unknown }>;

export async function runConfirmedActivation(
  activate: () => Promise<void>,
  afterActivation: () => void,
): Promise<ActivationOutcome> {
  try {
    await activate();
  } catch (activationError) {
    return { activated: false, activationError };
  }

  try {
    afterActivation();
    return { activated: true };
  } catch (uiError) {
    return { activated: true, uiError };
  }
}

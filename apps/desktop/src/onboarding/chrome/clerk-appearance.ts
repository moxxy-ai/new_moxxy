/**
 * Clerk wiring for the onboarding auth step — the publishable key
 * (`VITE_CLERK_PUBLISHABLE_KEY`; absent ⇒ the auth step auto-satisfies so
 * keyless dev builds aren't blocked) and the branded `<SignIn>` appearance
 * that strips Clerk's default chrome and recolours it to read as part of
 * our wizard. A dependency leaf — no React component code.
 */

export const CLERK_KEY = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as string | undefined;

/**
 * Strip every piece of Clerk's default chrome (card border + shadow,
 * brand header, "Secured by Clerk" footer, OAuth icons) and recolour
 * the bits we keep so the embedded SignIn reads as part of our
 * wizard. The footer's "Development mode" badge is added by Clerk's
 * dev key — it's intentional and disappears when you swap in a
 * production key.
 */
export const brandedClerkAppearance = {
  variables: {
    colorPrimary: '#ec4899',
    colorBackground: '#ffffff',
    colorText: '#0f172a',
    colorTextSecondary: '#475569',
    colorInputBackground: '#f7f8fc',
    colorInputText: '#0f172a',
    colorDanger: '#ef4444',
    borderRadius: '10px',
    fontFamily:
      "'Inter', system-ui, -apple-system, BlinkMacSystemFont, sans-serif",
  },
  layout: {
    logoPlacement: 'none',
    showOptionalFields: false,
    socialButtonsVariant: 'blockButton',
    socialButtonsPlacement: 'top',
    helpPageUrl: '',
  },
  elements: {
    rootBox: { width: '100%' },
    cardBox: {
      width: '100%',
      maxWidth: 'none',
      boxShadow: 'none',
      border: 'none',
      background: 'transparent',
    },
    card: {
      width: '100%',
      maxWidth: 'none',
      background: 'transparent',
      boxShadow: 'none',
      border: 'none',
      padding: 0,
    },
    main: { width: '100%', gap: 14, padding: 0 },
    form: { width: '100%', gap: 12 },
    // Header is hidden via title/subtitle styles below, but the
    // container still reserves its padding — collapse it so the OAuth
    // row sits flush with the card top.
    header: { display: 'none', padding: 0, margin: 0 },
    // The field hint ("Example format: name@example.com") rendered
    // BELOW the input was floating over the Continue button. Drop it
    // — the placeholder + autocomplete is enough.
    formFieldHintText: { display: 'none' },
    formFieldInfoText: { display: 'none' },
    formFieldSuccessText: { display: 'none' },
    formFieldRow: { gap: 6 },
    formFieldAction: { color: 'var(--color-primary-strong)' },
    headerTitle: { display: 'none' },
    headerSubtitle: { display: 'none' },
    logoBox: { display: 'none' },
    footer: { display: 'none' },
    footerAction: { display: 'none' },
    socialButtons: { gap: 8 },
    socialButtonsBlockButton: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 8,
      border: '1px solid var(--color-card-border)',
      background: '#fff',
      color: 'var(--color-text)',
      fontWeight: 600,
      borderRadius: 10,
      boxShadow: 'none',
      height: 42,
      minHeight: 42,
      lineHeight: 1,
      padding: '0 14px',
      overflow: 'visible',
      '&:hover': { background: '#f7f8fc', border: '1px solid var(--color-card-border-strong)' },
      '&::after': { display: 'none' },
      '&::before': { display: 'none' },
    },
    socialButtonsBlockButtonText: { fontWeight: 600, fontSize: 13, lineHeight: 1 },
    socialButtonsBlockButtonArrow: { display: 'none' },
    dividerLine: { background: 'var(--color-card-border)' },
    dividerText: {
      color: 'var(--color-text-dim)',
      fontSize: 11,
      textTransform: 'uppercase',
      letterSpacing: '0.08em',
    },
    formFieldLabel: {
      fontSize: 12.5,
      fontWeight: 600,
      color: 'var(--color-text-muted)',
      marginBottom: 2,
    },
    formFieldInput: {
      width: '100%',
      height: 42,
      minHeight: 42,
      background: '#f7f8fc',
      border: '1px solid var(--color-card-border)',
      borderRadius: 10,
      padding: '0 12px',
      fontSize: 14,
      lineHeight: 1.2,
      color: 'var(--color-text)',
      boxShadow: 'none',
      transition: 'border-color 120ms ease, box-shadow 120ms ease',
      '&:focus, &:focus-visible': {
        outline: 'none',
        border: '1px solid var(--color-primary)',
        boxShadow: '0 0 0 3px rgba(236, 72, 153, 0.15)',
      },
      '&::placeholder': { color: 'var(--color-text-dim)' },
    },
    formButtonPrimary: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 6,
      width: '100%',
      height: 42,
      minHeight: 42,
      lineHeight: 1,
      padding: '0 16px',
      background: 'var(--grad-cta)',
      color: '#fff',
      fontWeight: 600,
      fontSize: 13.5,
      borderRadius: 10,
      boxShadow: '0 8px 18px -12px rgba(236, 72, 153, 0.55)',
      textTransform: 'none',
      letterSpacing: 0,
      overflow: 'visible',
      '&:hover': { filter: 'brightness(1.05)' },
      '&::after': { display: 'none' },
      '&::before': { display: 'none' },
    },
    formButtonPrimaryArrow: { display: 'none' },
    spinner: { color: '#fff' },
    identityPreviewEditButton: { color: 'var(--color-primary-strong)' },
  },
} as const;

// Stub for `react-devtools-core`, which ink dynamically imports only when
// `process.env.DEV === 'true'`. It is a dev-only dependency and not installed
// in production, so we alias it to this empty module at bundle time. The
// devtools code path is never reached in a normal `moxxy` run.
export default {};

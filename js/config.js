// ICE frontend configuration (multi-project).
// Per-project branding (name, tagline, site URL, registration/provisioning
// flags) lives in the central registry sheet and arrives via bootstrap —
// EVENT_NAME/EVENT_TAGLINE below are only pre-bootstrap fallbacks.
window.ICE_CONFIG = {
  DEFAULT_PROJECT: 'ice2026',
  EVENT_NAME: 'ICE',
  EVENT_TAGLINE: 'Innovation & Collaboration Experience',
  API_URL: 'https://script.google.com/macros/s/AKfycbz0THh0OrmG8umv5ZomVvv1kQu7Ogs1jYp2tKqJFOe6gAMWGnL5Y5_Ww5hZOFVeNSA/exec',
  AUTH_URL: 'https://script.google.com/macros/s/AKfycbwvFYU1o9pwCePbf3mTINgqsZhbVeeCX97M3rG76DN74sLSyJRDdXXqaqbnbTlVPONZ/exec',
  // Direct 1:1 messaging (Google Chat) is TEMPORARILY DISABLED while messaging
  // is re-architected. false hides the chat FAB, the chat/broadcast pane, and
  // the profile "Message" buttons — all the code stays in place (js/chat.js and
  // the chat-* handlers). To restore: flip to true (CHAT_CLIENT_ID must be set).
  CHAT_ENABLED: false,
  // Google Chat handoff — OAuth web client ID from the ahlab.org GCP project.
  // Empty = chat buttons show a "not set up yet" message. See docs/google-chat-setup.md.
  CHAT_CLIENT_ID: '664996878590-6chfseq2fn94ir8fg2tj53oncl2ebh74.apps.googleusercontent.com',
  // Suggested skills shown in the tag picker (existing users' skills are merged in)
  SKILL_SUGGESTIONS: [
    'UX', 'Interaction Design', 'Study Design', 'Data Science', 'Data Analytics',
    'Machine Learning', 'Hardware', 'Embedded Systems', 'Mobile Apps', 'Web Development',
    'Fundraising', 'Pitch Deck', 'Strategy', 'Business', 'Content Writing',
    'Figma', '3D Printing', 'Electronics', 'Computer Vision', 'Prototyping',
  ],
};

// Dev server proxy: the website calls /api and /downloads on its own origin and they are forwarded here.
// Point it elsewhere with NOTES_DEV_API_TARGET=https://api.example.com
const target = process.env.NOTES_DEV_API_TARGET || 'http://localhost:3000';

export default {
  '/api': { target, secure: false, changeOrigin: !target.startsWith('http://localhost') },
  '/downloads': { target, secure: false, changeOrigin: !target.startsWith('http://localhost') },
};

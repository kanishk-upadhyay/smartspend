import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react' // Wait, this is react-ts template but sometimes it defaults or I misread? 
// Re-checking the template I used: react-ts. 
// It should be @vitejs/plugin-react.
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
  ],
})

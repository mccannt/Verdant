import type { Config } from 'tailwindcss';

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // Brand Palette
        verdant: {
          light: '#F2F5F3',  // Light background
          DEFAULT: '#00373A', // Deep Forest Green (Primary)
          dark: '#002629',    // Darker shade
          accent: '#00544E',  // Teal Accent
          text: '#0a0a0a',    // Rich Black Text
          'text-light': '#ffffff', // White Text
        },
        // Legacy/Utility (mapped to new brand where possible)
        ink: '#0a0a0a',
        moss: '#00544E',
        ember: '#b85042', // Keep error color
        'gs-teal': '#00544E',
        'gs-blue': '#9DC6D7', // Keep for some accents/status
        'gs-dark': '#00373A',
        'gs-gray': '#F2F5F3',
        'gs-white': '#FFFFFF',
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'Fira Code', 'monospace'],
      },
      boxShadow: {
        panel: '0 4px 20px -2px rgba(0, 55, 58, 0.1)',
        'panel-dark': '0 4px 20px -2px rgba(0, 0, 0, 0.5)',
      }
    }
  },
  plugins: []
} satisfies Config;

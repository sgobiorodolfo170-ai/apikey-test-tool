module.exports = {
  content: [
    "./index.html",
    "./src/**/*.{vue,js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        canvas: '#F9F2EA',
        surface: {
          DEFAULT: '#FFFFFF',
          alt: '#F9F2EA',
          hover: '#f0ebe5',
        },
        border: {
          DEFAULT: '#e5e7eb',
          light: '#d1d5db',
        },
        text: {
          primary: '#1f2937',
          secondary: '#6b7280',
          muted: '#9ca3af',
        },
        accent: {
          DEFAULT: '#3b82f6',
          hover: '#2563eb',
          muted: '#1e40af',
        },
        success: {
          DEFAULT: '#10b981',
          hover: '#059669',
          muted: '#065f46',
        },
        danger: {
          DEFAULT: '#ef4444',
          hover: '#dc2626',
          muted: '#991b1b',
        },
        warning: {
          DEFAULT: '#f59e0b',
          hover: '#d97706',
          muted: '#92400e',
        },
      },
      borderRadius: {
        card: '0.75rem',
        input: '0.5rem',
        btn: '0.5rem',
      },
      boxShadow: {
        card: '0 1px 3px rgba(0,0,0,0.3), 0 1px 2px rgba(0,0,0,0.2)',
        elevated: '0 4px 12px rgba(0,0,0,0.4)',
      },
    },
  },
  plugins: [],
}

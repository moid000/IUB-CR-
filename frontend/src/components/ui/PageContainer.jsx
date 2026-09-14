export function PageContainer({ children, center = false, className = '' }) {
  return (
    <main className={`min-h-dvh w-full ${center ? 'grid place-items-center px-4' : 'mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8'} ${className}`}>
      {children}
    </main>
  );
}

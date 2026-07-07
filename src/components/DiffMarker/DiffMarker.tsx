interface DiffMarkerProps {
  label: string
  children: string
}

export function DiffMarker({ label, children }: DiffMarkerProps) {
  return (
    <mark className="rounded bg-red-100 px-1 text-red-800">
      {label} {children}
    </mark>
  )
}

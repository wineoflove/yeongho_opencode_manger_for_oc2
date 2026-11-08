export function Sparkline({ values }: { readonly values: readonly (number | null)[] }) {
  const max = Math.max(1, ...values.filter((value): value is number => value !== null))
  const segments: string[][] = []
  let segment: string[] = []
  values.forEach((value, index) => {
    if (value === null) {
      if (segment.length) segments.push(segment)
      segment = []
    } else {
      segment.push(`${values.length < 2 ? 50 : (index * 100) / (values.length - 1)},${30 - (value / max) * 28}`)
    }
  })
  if (segment.length) segments.push(segment)
  return (
    <svg viewBox="0 0 100 32" preserveAspectRatio="none" className="h-8 w-full text-sky-500" aria-hidden="true">
      {segments.map((points, index) => (
        <g key={index}>
          <polygon
            points={`${points[0].split(',')[0]},32 ${points.join(' ')} ${points.at(-1)?.split(',')[0]},32`}
            fill="currentColor"
            opacity="0.12"
          />
          <polyline
            points={points.join(' ')}
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            vectorEffect="non-scaling-stroke"
          />
        </g>
      ))}
    </svg>
  )
}

import { useCallback, useMemo } from 'react'
import { Combobox, type ComboboxOption } from '@/components/ui/combobox'
import { useModelSections } from '@/hooks/useModelSections'
import { filterModelSections, toModelComboboxOptions } from '@/lib/modelSections'
import { cn } from '@/lib/utils'

interface ModelComboboxProps {
  value: string
  onChange: (value: string) => void
  directory?: string
  enabled?: boolean
  placeholder?: string
  allowCustomValue?: boolean
  showClear?: boolean
  ariaLabel?: string
  id?: string
  disabled?: boolean
  className?: string
  listClassName?: string
  emptyMeansDefault?: boolean
  sessionDefault?: boolean
}

export function ModelCombobox({
  value,
  onChange,
  directory,
  enabled = true,
  placeholder,
  allowCustomValue,
  showClear,
  ariaLabel,
  id,
  disabled,
  className,
  listClassName,
  emptyMeansDefault = true,
  sessionDefault,
}: ModelComboboxProps) {
  const { sections, defaultModel: resolvedDefault } = useModelSections(directory, { enabled, sessionDefault })
  const defaultModel = emptyMeansDefault ? resolvedDefault : null

  const options = useMemo(() => toModelComboboxOptions(sections, defaultModel), [sections, defaultModel])

  const filterOptions = useCallback(
    (_options: ComboboxOption[], query: string) =>
      toModelComboboxOptions(filterModelSections(sections, query), defaultModel),
    [sections, defaultModel],
  )

  return (
    <Combobox
      id={id}
      value={value}
      onChange={onChange}
      options={options}
      filterOptions={filterOptions}
      placeholder={placeholder}
      allowCustomValue={allowCustomValue}
      showClear={showClear}
      ariaLabel={ariaLabel}
      disabled={disabled}
      className={className}
      listClassName={cn('max-h-[min(24rem,60vh)]', listClassName)}
    />
  )
}

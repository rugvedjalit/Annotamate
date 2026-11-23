import type { ReactNode } from 'react'
import { Monitor, Moon, MousePointer2, SquareDashed, Sun, Volume2 } from 'lucide-react'
import { SETTINGS_LIMITS } from '@/lib/settings'
import { formatCombo } from '@/lib/keymap'
import { playChime } from '@/lib/sound'
import { useBindings } from '@/hooks/useBindings'
import { useSettings } from '@/stores/settings'
import { Button } from '@/components/ui/Button'
import { SegmentedControl } from '@/components/ui/SegmentedControl'
import { Slider } from '@/components/ui/Slider'
import { Switch, SwitchRow } from '@/components/ui/Switch'
import { SettingsCard } from './SettingsCard'

function Row({ label, description, control, id }: { label: string; description?: ReactNode; control: ReactNode; id?: string }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 py-2.5">
      <div className="min-w-0 flex-1">
        <div id={id} className="text-base text-fg">
          {label}
        </div>
        {description && <div className="mt-0.5 text-sm text-muted">{description}</div>}
      </div>
      <div className="shrink-0">{control}</div>
    </div>
  )
}

function SliderRow({
  label,
  description,
  value,
  min,
  max,
  step,
  format,
  onChange,
  disabled,
}: {
  label: string
  description?: ReactNode
  value: number
  min: number
  max: number
  step: number
  format: (v: number) => string
  onChange: (v: number) => void
  disabled?: boolean
}) {
  return (
    <Row
      label={label}
      description={description}
      control={
        <div className="flex w-64 items-center gap-3">
          <Slider
            aria-label={label}
            min={min}
            max={max}
            step={step}
            value={[value]}
            disabled={disabled}
            onValueChange={(v) => v[0] !== undefined && onChange(v[0])}
            className={disabled ? 'opacity-50' : undefined}
          />
          <span className="w-16 text-right font-mono text-sm tabular text-muted">{format(value)}</span>
        </div>
      }
    />
  )
}

/** Live preview of the box style chosen below. */
function BoxPreview({ fill, stroke, labels }: { fill: number; stroke: number; labels: boolean }) {
  const color = '#3b82f6'
  return (
    <div className="canvas-backdrop grid h-28 w-44 shrink-0 place-items-center overflow-hidden rounded-lg border border-line" aria-hidden>
      <svg width="140" height="88" viewBox="0 0 140 88">
        <rect x="0" y="0" width="140" height="88" fill="#6f93bb" opacity="0.35" />
        <rect x="26" y="26" width="90" height="50" fill={color} fillOpacity={fill} stroke={color} strokeWidth={stroke} />
        {labels && (
          <>
            <rect x="26" y="12" width="28" height="14" rx="3" fill={color} />
            <text x="31" y="22.5" fontSize="10" fontWeight="600" fill="#fff" fontFamily="Inter Variable, Inter, sans-serif">
              car
            </text>
          </>
        )}
      </svg>
    </div>
  )
}

export function PreferencesSection() {
  const settings = useSettings((s) => s.settings)
  const update = useSettings((s) => s.update)
  const bindings = useBindings()
  const saveCombo = bindings.save[0]

  return (
    <div className="flex flex-col gap-5">
      <SettingsCard title="Appearance" description="Changes apply immediately and are saved to your account.">
        <Row
          label="Theme"
          description="System follows your operating system's light or dark mode."
          control={
            <SegmentedControl
              aria-label="Theme"
              value={settings.theme}
              onValueChange={(theme) => update({ theme })}
              options={[
                { value: 'dark', label: 'Dark', icon: <Moon /> },
                { value: 'light', label: 'Light', icon: <Sun /> },
                { value: 'system', label: 'System', icon: <Monitor /> },
              ]}
            />
          }
        />
      </SettingsCard>

      <SettingsCard title="Saving" description="Annotations are saved to the label files on the server.">
        <div className="divide-y divide-line">
          <SwitchRow
            label="Autosave"
            description={
              settings.autosave
                ? 'Changes are saved shortly after you stop editing, and always before moving to another image.'
                : `Save with ${saveCombo ? formatCombo(saveCombo) : 'the Save command'}. Changes are still saved before moving to another image.`
            }
            checked={settings.autosave}
            onCheckedChange={(autosave) => update({ autosave })}
            className="py-2.5"
          />
          <SliderRow
            label="Autosave delay"
            description="Wait after the last change before saving."
            value={settings.autosave_delay_ms}
            min={SETTINGS_LIMITS.autosave_delay_ms[0]}
            max={SETTINGS_LIMITS.autosave_delay_ms[1]}
            step={100}
            disabled={!settings.autosave}
            format={(v) => (v >= 1000 ? `${(v / 1000).toFixed(1)} s` : `${v} ms`)}
            onChange={(autosave_delay_ms) => update({ autosave_delay_ms })}
          />
        </div>
      </SettingsCard>

      <SettingsCard title="Drawing">
        <div className="divide-y divide-line">
          <SwitchRow
            label="Ask for class after drawing"
            description="Opens the class picker next to every new box. When off, new boxes get the active class."
            checked={settings.ask_class_after_draw}
            onCheckedChange={(ask_class_after_draw) => update({ ask_class_after_draw })}
            className="py-2.5"
          />
          <Row
            label="Tool after drawing"
            description="Keep drawing boxes, or switch to selection to adjust the new box."
            control={
              <SegmentedControl
                aria-label="Tool after drawing"
                value={settings.tool_after_draw}
                onValueChange={(tool_after_draw) => update({ tool_after_draw })}
                options={[
                  { value: 'box', label: 'Box tool', icon: <SquareDashed /> },
                  { value: 'select', label: 'Select tool', icon: <MousePointer2 /> },
                ]}
              />
            }
          />
          <Row
            label="Mouse wheel"
            description={
              settings.wheel === 'zoom'
                ? 'The wheel zooms at the pointer; drag with the middle button or hold Space to pan.'
                : 'The wheel pans the image; hold Ctrl (⌘ on macOS) or pinch to zoom.'
            }
            control={
              <SegmentedControl
                aria-label="Mouse wheel"
                value={settings.wheel}
                onValueChange={(wheel) => update({ wheel })}
                options={[
                  { value: 'zoom', label: 'Zoom' },
                  { value: 'scroll', label: 'Scroll' },
                ]}
              />
            }
          />
        </div>
      </SettingsCard>

      <SettingsCard title="Boxes and canvas">
        <div className="flex flex-col gap-5 lg:flex-row">
          <div className="min-w-0 flex-1 divide-y divide-line">
            <SliderRow
              label="Fill opacity"
              value={settings.fill_opacity}
              min={SETTINGS_LIMITS.fill_opacity[0]}
              max={SETTINGS_LIMITS.fill_opacity[1]}
              step={0.02}
              format={(v) => `${Math.round(v * 100)}%`}
              onChange={(fill_opacity) => update({ fill_opacity })}
            />
            <SliderRow
              label="Stroke width"
              value={settings.stroke_width}
              min={SETTINGS_LIMITS.stroke_width[0]}
              max={SETTINGS_LIMITS.stroke_width[1]}
              step={0.5}
              format={(v) => `${v} px`}
              onChange={(stroke_width) => update({ stroke_width })}
            />
            <SwitchRow
              label="Show labels"
              description="Class name chips above boxes (toggle any time in the annotator)."
              checked={settings.show_labels}
              onCheckedChange={(show_labels) => update({ show_labels })}
              className="py-2.5"
            />
            <SwitchRow
              label="Show crosshair"
              description="Guide lines across the image under the pointer."
              checked={settings.show_crosshair}
              onCheckedChange={(show_crosshair) => update({ show_crosshair })}
              className="py-2.5"
            />
          </div>
          <BoxPreview fill={settings.fill_opacity} stroke={settings.stroke_width} labels={settings.show_labels} />
        </div>
      </SettingsCard>

      <SettingsCard title="Notifications">
        <Row
          label="Play a sound"
          description="A short chime for direct messages, mentions and review results."
          control={
            <div className="flex items-center gap-3">
              <Button size="sm" variant="ghost" onClick={playChime}>
                <Volume2 />
                Test
              </Button>
              <Switch
                aria-label="Play a sound"
                checked={settings.notify_sound}
                onCheckedChange={(notify_sound) => update({ notify_sound })}
              />
            </div>
          }
        />
      </SettingsCard>
    </div>
  )
}

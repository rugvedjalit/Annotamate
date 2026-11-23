import { useState, type FormEvent } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { updateMe } from '@/lib/endpoints'
import { errorMessage } from '@/lib/api'
import { qk } from '@/lib/queryKeys'
import { AVATAR_COLORS } from '@/lib/colors'
import { formatDate } from '@/lib/format'
import type { AuthState, UpdateMeBody } from '@/lib/types'
import { useMe, useSession } from '@/stores/session'
import { Avatar } from '@/components/ui/Avatar'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Field } from '@/components/ui/Field'
import { Input } from '@/components/ui/Input'
import { ColorSwatches } from '@/components/ColorSwatches'
import { SettingsCard } from './SettingsCard'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export function ProfileSection() {
  const me = useMe()
  const qc = useQueryClient()
  const [displayName, setDisplayName] = useState(me.display_name)
  const [email, setEmail] = useState(me.email ?? '')
  const [color, setColor] = useState(me.avatar_color)

  const save = useMutation({
    mutationFn: (body: UpdateMeBody) => updateMe(body),
    onSuccess: (user) => {
      useSession.getState().patchUser(user)
      qc.setQueryData<AuthState>(qk.authState, (s) => (s ? { ...s, user } : s))
      void qc.invalidateQueries({ queryKey: qk.usersAll })
      toast.success('Profile saved')
    },
    onError: (err) => toast.error('Could not save your profile', { description: errorMessage(err) }),
  })

  const nameError = !displayName.trim() ? 'Enter your name.' : null
  const emailError = email.trim() && !EMAIL_RE.test(email.trim()) ? 'Enter a valid email address.' : null
  const changed =
    displayName.trim() !== me.display_name || (email.trim() || null) !== me.email || color.toLowerCase() !== me.avatar_color.toLowerCase()

  function submit(e: FormEvent) {
    e.preventDefault()
    if (nameError || emailError || !changed) return
    save.mutate({ display_name: displayName.trim(), email: email.trim() || null, avatar_color: color })
  }

  function reset() {
    setDisplayName(me.display_name)
    setEmail(me.email ?? '')
    setColor(me.avatar_color)
  }

  return (
    <form onSubmit={submit} noValidate>
      <SettingsCard
        title="Profile"
        description="How teammates see you in chat, comments, presence and assignments."
        footer={
          <>
            <Button variant="ghost" disabled={!changed || save.isPending} onClick={reset}>
              Discard
            </Button>
            <Button type="submit" variant="primary" disabled={!changed || !!nameError || !!emailError} loading={save.isPending}>
              Save profile
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-6 md:flex-row">
          <div className="flex shrink-0 flex-col items-center gap-2 md:w-40">
            <Avatar user={{ display_name: displayName || me.display_name, avatar_color: color }} size="xl" tooltip={false} />
            <div className="text-center">
              <div className="font-mono text-sm text-muted">@{me.username}</div>
              <div className="mt-1 flex flex-wrap justify-center gap-1">
                {me.is_admin && <Badge variant="accent">Admin</Badge>}
                <Badge variant="outline">Since {formatDate(me.created_at)}</Badge>
              </div>
            </div>
          </div>
          <div className="flex min-w-0 flex-1 flex-col gap-4">
            <Field
              label="Display name"
              htmlFor="pf-name"
              hint={`Shown to your team. Your username (@${me.username}) cannot be changed; an administrator can help if needed.`}
              error={nameError}
            >
              <Input
                id="pf-name"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                aria-invalid={!!nameError}
                aria-describedby="pf-name-desc"
              />
            </Field>
            <Field label="Email" htmlFor="pf-email" hint="Optional. Visible to administrators." error={emailError}>
              <Input
                id="pf-email"
                type="email"
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                aria-invalid={!!emailError}
              />
            </Field>
            <Field label="Avatar colour">
              <ColorSwatches value={color} onChange={setColor} colors={AVATAR_COLORS} allowCustom label="Avatar colour" />
            </Field>
          </div>
        </div>
      </SettingsCard>
    </form>
  )
}

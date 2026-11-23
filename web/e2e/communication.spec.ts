import {
  canvasPoint,
  datasetImages,
  expect,
  openAnnotator,
  suffix,
  test,
  type Account,
} from './support'

// Communication: project chat in realtime with an @mention notification; direct messages in realtime with
// unread badges and a live read receipt; image comments with a pin that show up live and can be resolved.

test('project chat, @mentions, direct messages and pinned image comments', async ({ adminApi, actors }, testInfo) => {
  test.setTimeout(120_000)
  const sfx = suffix(testInfo.retry)
  const cleo: Account = { name: 'Cleo Chat', username: `cleo${sfx}`, password: 'comms-annotator-1' }
  const dan: Account = { name: 'Dan Dialog', username: `dan${sfx}`, password: 'comms-reviewer-1' }
  const cleoUser = await adminApi.ensureUser(cleo)
  const danUser = await adminApi.ensureUser(dan)
  const project = await adminApi.createProject(`Comms${sfx}`, 'comms', {
    members: [
      { user_id: cleoUser.id, role: 'annotator' },
      { user_id: danUser.id, role: 'reviewer' },
    ],
  })
  const first = await adminApi.image(project.id, datasetImages('comms')[0]!)

  const c = await actors.signIn(cleo)
  const d = await actors.signIn(dan)
  await c.page.goto(`/p/${project.id}`)
  await d.page.goto(`/p/${project.id}`)
  const danBell = d.page.getByRole('button', { name: /^Notifications/ })
  await expect(danBell).toHaveAccessibleName('Notifications, 1 unread') // added to the project
  const danChatButton = d.page.getByRole('button', { name: 'Project chat' })
  await expect(danChatButton).toBeVisible()

  // ------------------------------------------------------------------ project chat with an @mention
  await c.page.getByRole('button', { name: 'Project chat' }).click()
  const cleoComposer = c.page.getByRole('textbox', { name: 'Chat message' })
  await expect(cleoComposer).toBeFocused()
  await cleoComposer.pressSequentially('Hey @da')
  const mentionList = c.page.getByRole('listbox', { name: 'Mention someone' })
  await expect(mentionList.getByRole('option', { name: new RegExp(dan.name) })).toBeVisible()
  await cleoComposer.press('Enter') // inserts the mention, does not send
  await expect(cleoComposer).toHaveValue(`Hey @${dan.username} `)
  await cleoComposer.pressSequentially('can you check frame 2?')
  await cleoComposer.press('Enter')
  await expect(cleoComposer).toHaveValue('')
  const cleoLog = c.page.getByRole('log', { name: 'Chat messages' })
  await expect(cleoLog.getByText('can you check frame 2?')).toBeVisible()

  // Dan: unread badge on the chat button, a mention notification on the bell (and a toast).
  await expect(danChatButton).toContainText('1')
  await expect(danBell).toHaveAccessibleName('Notifications, 2 unread')
  await expect(d.page.getByText(`${cleo.name} mentioned you`).first()).toBeVisible()
  await danChatButton.click()
  const danLog = d.page.getByRole('log', { name: 'Chat messages' })
  await expect(danLog.getByText('can you check frame 2?')).toBeVisible()
  await expect(d.page.getByRole('button', { name: 'Close project chat' })).not.toContainText('1')
  const danComposer = d.page.getByRole('textbox', { name: 'Chat message' })
  await danComposer.fill('On it, looking now')
  await danComposer.press('Enter')
  await expect(cleoLog.getByText('On it, looking now')).toBeVisible() // live for Cleo
  await d.page.keyboard.press('Escape')
  await expect(danLog).toBeHidden()

  // The mention notification opens from the bell and is marked read.
  await danBell.click()
  const mention = d.page.getByRole('button', { name: new RegExp(`${cleo.name} mentioned you`) })
  await expect(mention).toBeVisible()
  await d.page.getByRole('button', { name: 'Mark all read' }).click()
  await expect(danBell).toHaveAccessibleName('Notifications')
  await d.page.keyboard.press('Escape')

  // ------------------------------------------------------------------ direct messages
  await c.page.goto('/messages')
  await c.page.getByRole('button', { name: 'New message' }).first().click()
  const picker = c.page.getByRole('dialog', { name: 'New message' })
  await picker.getByPlaceholder('Search people…').fill(dan.name)
  await picker.getByRole('option', { name: new RegExp(dan.name) }).click()
  await expect(c.page).toHaveURL(new RegExp(`/messages/${danUser.id}$`))
  const toDan = c.page.getByRole('textbox', { name: `Message ${dan.name}` })
  await toDan.fill('Hi Dan, quick question about the labels')
  await toDan.press('Enter')
  await expect(toDan).toHaveValue('')
  const cleoThread = c.page.getByRole('log', { name: 'Messages' })
  await expect(cleoThread.getByText('Hi Dan, quick question about the labels')).toBeVisible()

  // Dan sees an unread badge on the DM button, then reads the conversation.
  const danDm = d.page.getByRole('link', { name: /^Direct messages/ })
  await expect(danDm).toHaveAccessibleName('Direct messages, 1 unread')
  await danDm.click()
  const conversation = d.page.getByRole('list', { name: 'Conversations' }).getByRole('link', { name: new RegExp(cleo.name) })
  await expect(conversation).toContainText('Hi Dan, quick question about the labels')
  await expect(conversation.getByLabel('1 unread')).toBeVisible()
  await conversation.click()
  await expect(d.page.getByRole('log', { name: 'Messages' }).getByText('Hi Dan, quick question about the labels')).toBeVisible()
  await expect(danDm).toHaveAccessibleName('Direct messages')
  await expect(conversation.getByLabel('1 unread')).toHaveCount(0)
  // The DM notification is cleared with the conversation.
  await expect(danBell).toHaveAccessibleName('Notifications')
  // Cleo sees the read receipt live.
  await expect(cleoThread.getByText(/^Seen/)).toBeVisible()

  const toCleo = d.page.getByRole('textbox', { name: `Message ${cleo.name}` })
  await toCleo.fill('Sure, ask away')
  await toCleo.press('Enter')
  await expect(cleoThread.getByText('Sure, ask away')).toBeVisible() // live, no reload
  await expect(c.page.getByRole('link', { name: /^Direct messages/ })).toHaveAccessibleName('Direct messages') // viewing it

  // ------------------------------------------------------------------ image comments with a pin
  await openAnnotator(c.page, project.id, first.id)
  await openAnnotator(d.page, project.id, first.id, { editable: false })
  const danInspector = d.page.getByRole('complementary', { name: 'Inspector' })
  const cleoInspector = c.page.getByRole('complementary', { name: 'Inspector' })
  await danInspector.getByRole('tab', { name: /Comments/ }).click()
  await cleoInspector.getByRole('tab', { name: /Comments/ }).click()
  await danInspector.getByRole('button', { name: 'Add pin' }).click()
  await expect(danInspector.getByRole('button', { name: 'Click the image…' })).toBeVisible()
  const spot = await canvasPoint(d.page, 0.5, 0.5)
  await d.page.mouse.click(spot.x, spot.y)
  await expect(danInspector.getByText(/^Pin at \d+, \d+$/)).toBeVisible()
  await danInspector.getByRole('textbox', { name: 'New comment' }).fill('This blue post should be boxed')
  await danInspector.getByRole('button', { name: 'Comment', exact: true }).click()
  await expect(danInspector.getByRole('listitem').filter({ hasText: 'This blue post should be boxed' })).toBeVisible()

  // Live on Cleo's side, with the pin and the open-comment badge.
  const live = cleoInspector.getByRole('listitem').filter({ hasText: 'This blue post should be boxed' })
  await expect(live).toBeVisible()
  await expect(live.getByRole('button', { name: /^Pin 1 at \d+, \d+$/ })).toBeVisible()
  await expect(cleoInspector.getByRole('tab', { name: /Comments/ })).toContainText('1')
  await expect(c.page.getByRole('listbox', { name: 'Images' }).getByLabel('1 open comments')).toBeVisible()

  // Cleo resolves it; Dan sees it resolved live.
  await live.getByRole('button', { name: 'Resolve' }).click()
  await expect(live.getByText('Resolved')).toBeVisible()
  const danComment = danInspector.getByRole('listitem').filter({ hasText: 'This blue post should be boxed' })
  await expect(danComment.getByText('Resolved')).toBeVisible()
  await expect(cleoInspector.getByRole('tab', { name: /Comments/ })).not.toContainText('1')
  const comments = await adminApi.get<{ resolved: boolean; pin: { x: number; y: number } | null }[]>(
    `projects/${project.id}/images/${first.id}/comments`,
  )
  expect(comments).toHaveLength(1)
  expect(comments[0]!.resolved).toBe(true)
  expect(comments[0]!.pin).not.toBeNull()
})

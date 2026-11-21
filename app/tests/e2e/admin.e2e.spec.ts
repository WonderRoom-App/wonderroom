import { test, expect, Page } from '@playwright/test'
import { login } from '../helpers/login'
import { seedTestUser, cleanupTestUser, testUser } from '../helpers/seedUser'

test.describe('Admin Panel', () => {
  let page: Page

  test.beforeAll(async ({ browser }) => {
    await seedTestUser()

    const context = await browser.newContext()
    page = await context.newPage()

    await login({ page, user: testUser })
  })

  test.afterAll(async () => {
    await cleanupTestUser()
  })

  test('can navigate to dashboard', async () => {
    await page.goto('http://localhost:3000/admin')
    await expect(page).toHaveURL('http://localhost:3000/admin')
    const dashboardArtifact = page.locator('span[title="Dashboard"]').first()
    await expect(dashboardArtifact).toBeVisible()
  })

  test('can navigate to list view', async () => {
    await page.goto('http://localhost:3000/admin/collections/users')
    await expect(page).toHaveURL('http://localhost:3000/admin/collections/users')
    const listViewArtifact = page.locator('h1', { hasText: 'Users' }).first()
    await expect(listViewArtifact).toBeVisible()
  })

  test('can navigate to edit view', async () => {
    await page.goto('http://localhost:3000/admin/collections/users/create')
    await expect(page).toHaveURL(/\/admin\/collections\/users\/[a-zA-Z0-9-_]+/)
    const editViewArtifact = page.locator('input[name="email"]')
    await expect(editViewArtifact).toBeVisible()
  })

  test('curios is in the nav and a new curio shows in the list', async () => {
    await page.goto('http://localhost:3000/admin')
    await expect(page.locator('nav a[href="/admin/collections/curios"]')).toContainText('Curios')

    await page.goto('http://localhost:3000/admin/collections/curios/create')
    await page.fill('#field-title', 'Brass orrery')
    await page.click('#action-save')
    await expect(page).toHaveURL(/\/admin\/collections\/curios\/[a-zA-Z0-9-_]+/)

    await page.goto('http://localhost:3000/admin/collections/curios')
    await expect(page.getByText('Brass orrery').first()).toBeVisible()
  })
})

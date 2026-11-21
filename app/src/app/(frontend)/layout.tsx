import React from 'react'

export const metadata = {
  description: 'A self-hosted catalog for collectors.',
  title: 'WonderRoom',
}

export default async function RootLayout(props: { children: React.ReactNode }) {
  const { children } = props

  return (
    <html lang="en">
      <body>
        <main>{children}</main>
      </body>
    </html>
  )
}

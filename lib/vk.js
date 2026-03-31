export async function sendMessage(userId, message) {
  const params = new URLSearchParams()
  params.set('user_id', String(userId))
  params.set('random_id', String(Date.now()))
  params.set('message', message)
  params.set('access_token', process.env.VK_GROUP_TOKEN)
  params.set('v', '5.199')

  const res = await fetch('https://api.vk.com/method/messages.send', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
    },
    body: params.toString(),
  })

  const raw = await res.text()

  let json
  try {
    json = JSON.parse(raw)
  } catch (err) {
    throw new Error(`VK returned non-JSON response: ${raw.slice(0, 500)}`)
  }

  if (!res.ok) {
    throw new Error(`VK HTTP ${res.status}: ${raw.slice(0, 500)}`)
  }

  if (json.error) {
    throw new Error(`VK API error ${json.error.error_code}: ${json.error.error_msg}`)
  }

  return json
}

export async function sendMessage(user_id, message) {
  const url = new URL('https://api.vk.com/method/messages.send')
  url.searchParams.set('user_id', user_id)
  url.searchParams.set('message', message)
  url.searchParams.set('random_id', Date.now())
  url.searchParams.set('access_token', process.env.VK_GROUP_TOKEN)
  url.searchParams.set('v', '5.199')

  const res = await fetch(url.toString())
  const json = await res.json()
  if (json.error) throw new Error(`VK sendMessage error: ${json.error.error_msg}`)
  return json
}

import { TestNetwork } from '@atproto/dev-env'
import { TestUser, createTestNetwork, createTestUser } from './_util'

describe('chat smoke test', () => {
  let network: TestNetwork
  let alice: TestUser
  let bob: TestUser

  beforeAll(async () => {
    network = await createTestNetwork()
    alice = await createTestUser(network, 'alice.test')
    bob = await createTestUser(network, 'bob.test')
  })

  afterAll(async () => {
    await network.close()
  })

  it('creates a conversation and sends a message', async () => {
    // Alice initiates a conversation with Bob
    const convoRes = (await alice.agent.getConvoForMembers([
      alice.did,
      bob.did,
    ])) as { convo: { id: string; members: Array<{ did: string }> } }

    expect(convoRes.convo).toBeDefined()
    expect(convoRes.convo.id).toBeTruthy()

    const convoId = convoRes.convo.id

    // Verify the convo has both members
    const memberDids = convoRes.convo.members.map((m) => m.did).sort()
    expect(memberDids).toEqual([alice.did, bob.did].sort())

    // Alice sends a message
    const msgRes = (await alice.agent.sendMessage(convoId, {
      text: 'Hello Bob!',
    })) as { id: string; text: string; sender: { did: string } }

    expect(msgRes.id).toBeTruthy()
    expect(msgRes.text).toBe('Hello Bob!')
    expect(msgRes.sender.did).toBe(alice.did)

    // Bob reads the messages in the conversation
    const messagesRes = (await bob.agent.getMessages(convoId)) as {
      messages: Array<{ id: string; text: string; sender: { did: string } }>
    }

    expect(messagesRes.messages).toBeDefined()
    expect(messagesRes.messages.length).toBeGreaterThanOrEqual(1)

    const aliceMsg = messagesRes.messages.find(
      (m) => m.sender.did === alice.did,
    )
    expect(aliceMsg).toBeDefined()
    expect(aliceMsg!.text).toBe('Hello Bob!')
  })

  it('both users can see the conversation in listConvos', async () => {
    const aliceConvos = (await alice.agent.listConvos()) as {
      convos: Array<{ id: string }>
    }
    const bobConvos = (await bob.agent.listConvos()) as {
      convos: Array<{ id: string }>
    }

    expect(aliceConvos.convos.length).toBeGreaterThanOrEqual(1)
    expect(bobConvos.convos.length).toBeGreaterThanOrEqual(1)

    // Both should see the same convo
    const aliceConvoIds = aliceConvos.convos.map((c) => c.id)
    const bobConvoIds = bobConvos.convos.map((c) => c.id)
    expect(aliceConvoIds).toEqual(expect.arrayContaining(bobConvoIds))
  })

  it('can get a conversation by ID', async () => {
    // First, get/create the convo
    const convoRes = (await alice.agent.getConvoForMembers([
      alice.did,
      bob.did,
    ])) as { convo: { id: string } }
    const convoId = convoRes.convo.id

    // Fetch it directly by ID
    const getRes = (await alice.agent.getConvo(convoId)) as {
      convo: { id: string; members: Array<{ did: string }> }
    }

    expect(getRes.convo.id).toBe(convoId)
    expect(getRes.convo.members.length).toBe(2)
  })

  it('can send multiple messages and paginate', async () => {
    const convoRes = (await alice.agent.getConvoForMembers([
      alice.did,
      bob.did,
    ])) as { convo: { id: string } }
    const convoId = convoRes.convo.id

    // Send a few more messages from Bob
    await bob.agent.sendMessage(convoId, { text: 'Hey Alice!' })
    await bob.agent.sendMessage(convoId, { text: 'How are you?' })

    // Fetch messages with a limit
    const page1 = (await alice.agent.getMessages(convoId, { limit: 2 })) as {
      messages: Array<{ id: string; text: string }>
      cursor?: string
    }

    expect(page1.messages.length).toBeLessThanOrEqual(2)

    // If there is a cursor, we can fetch the next page
    if (page1.cursor) {
      const page2 = (await alice.agent.getMessages(convoId, {
        limit: 2,
        cursor: page1.cursor,
      })) as {
        messages: Array<{ id: string; text: string }>
      }
      expect(page2.messages).toBeDefined()
    }
  })
})

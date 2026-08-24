import type { ToolDef } from './types.js'

/**
 * The one tool that changes what Otto is allowed to SAY rather than what it does.
 *
 * Everything else here writes to a store or reads one back. This spends a rung on a sentence Otto
 * is about to write, which means it is the only tool whose effect is undone by the model changing
 * its mind afterwards. Hence the warning repeated three times over — here, in the `TACK_ON` prompt
 * section, and in the tool's own result. Those three sit thousands of tokens apart in the same
 * cached prefix, and the tool block is the one that wins the argument at the moment of acting.
 *
 * A literal array, never a function — see the contract in ./index.ts.
 */
export const tackOnTools: ToolDef[] = [
  {
    name: 'chase_in_reply',
    description:
      'Chase ONE open reminder inside the reply you are about to write, instead of interrupting ' +
      'them with it separately later. Call it only for the single item you were given as this ' +
      "turn's tack-on, and only when you are definitely going to mention it in this reply. " +
      'This SPENDS the chase: the message you were going to send on your own is cancelled and the ' +
      'ladder moves on. Call it and then not mention the thing, and they never hear about it at ' +
      'all until the next rung. ' +
      'It comes back with what you are entitled to say — how late the thing is, and how many times ' +
      'you have already raised it — so word the question from that rather than from memory. ' +
      'Once per reply. It refuses a second call, and it refuses anything raised recently, because ' +
      'a reply that answers them and then asks two questions is a reply they stop reading. ' +
      'Never for something they have just told you about, and never for a reminder you created, ' +
      'changed or completed in this same turn.',
    parameters: {
      type: 'object',
      properties: {
        reminderId: {
          type: 'string',
          description:
            "The id you were given as this turn's tack-on. Never one you picked out of the " +
            'chase-list yourself, and never one from list_reminders.',
        },
      },
      required: ['reminderId'],
    },
  },
]

const fs = require('fs')

const path = 'src/server.ts'
let s = fs.readFileSync(path, 'utf8')

s = s.replace(
  `        private_link_success_message AS privateLinkSuccessMessage
      FROM system_telegram_config`,
  `        private_link_success_message AS privateLinkSuccessMessage,
        duplicate_connection_message AS duplicateConnectionMessage
      FROM system_telegram_config`
)

s = s.replace(
  `const privateLinkSuccessMessage =
      String(configRows[0].privateLinkSuccessMessage ?? '').trim() || 'Conta conectada com sucesso.'`,
  `const privateLinkSuccessMessage =
      String(configRows[0].privateLinkSuccessMessage ?? '').trim() || 'Conta conectada com sucesso.'
    const duplicateConnectionMessage =
      String(configRows[0].duplicateConnectionMessage ?? '').trim() ||
      'Esta conta já foi conectada anteriormente e não pode ser vinculada novamente.'`
)

s = s.replace(`'Esta conta já foi conectada anteriormente e não pode ser vinculada novamente.'`, 'duplicateConnectionMessage')
s = s.replace(`'Esta conta já foi conectada anteriormente e não pode ser vinculada novamente.'`, 'duplicateConnectionMessage')
s = s.replace(`'Esta conta já foi conectada anteriormente e não pode ser vinculada novamente.'`, 'duplicateConnectionMessage')

s = s.replace(
  `        private_link_success_message AS privateLinkSuccessMessage,
        updated_at AS updatedAt`,
  `        private_link_success_message AS privateLinkSuccessMessage,
        duplicate_connection_message AS duplicateConnectionMessage,
        updated_at AS updatedAt`
)

s = s.replace(
  `          privateLinkSuccessMessage: 'Conta conectada com sucesso.',`,
  `          privateLinkSuccessMessage: 'Conta conectada com sucesso.',
          alreadyLinkedMessage: 'Esta conta já foi conectada anteriormente e não pode ser vinculada novamente.',`
)

s = s.replace(
  `        privateLinkSuccessMessage:
          String(rows[0].privateLinkSuccessMessage ?? '').trim() || 'Conta conectada com sucesso.',`,
  `        privateLinkSuccessMessage:
          String(rows[0].privateLinkSuccessMessage ?? '').trim() || 'Conta conectada com sucesso.',
        alreadyLinkedMessage:
          String(rows[0].duplicateConnectionMessage ?? '').trim() ||
          'Esta conta já foi conectada anteriormente e não pode ser vinculada novamente.',`
)

s = s.replace(
  `  const { botToken, groupId, welcomeMessage, privateChatOnlyMessage, privateLinkSuccessMessage } = req.body as {`,
  `  const { botToken, groupId, welcomeMessage, privateChatOnlyMessage, privateLinkSuccessMessage, alreadyLinkedMessage } = req.body as {`
)

s = s.replace(
  `    privateLinkSuccessMessage?: string`,
  `    privateLinkSuccessMessage?: string
    alreadyLinkedMessage?: string`
)

s = s.replace(
  `  const parsedPrivateLinkSuccessMessage =
    String(privateLinkSuccessMessage ?? '').trim() || 'Conta conectada com sucesso.'`,
  `  const parsedPrivateLinkSuccessMessage =
    String(privateLinkSuccessMessage ?? '').trim() || 'Conta conectada com sucesso.'
  const parsedAlreadyLinkedMessage =
    String(alreadyLinkedMessage ?? '').trim() ||
    'Esta conta já foi conectada anteriormente e não pode ser vinculada novamente.'`
)

s = s.replace(
  `        private_link_success_message = VALUES(private_link_success_message),`,
  `        private_link_success_message = VALUES(private_link_success_message),
        duplicate_connection_message = VALUES(duplicate_connection_message),`
)

s = s.replace(
  `        parsedPrivateLinkSuccessMessage,`,
  `        parsedPrivateLinkSuccessMessage,
        parsedAlreadyLinkedMessage,`
)

s = s.replace(
  `        privateLinkSuccessMessage: parsedPrivateLinkSuccessMessage,`,
  `        privateLinkSuccessMessage: parsedPrivateLinkSuccessMessage,
        alreadyLinkedMessage: parsedAlreadyLinkedMessage,`
)

fs.writeFileSync(path, s, 'utf8')
console.log('patch applied')

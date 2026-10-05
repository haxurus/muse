export const truncate = (text: string, maxLength = 50) =>
  text.length > maxLength ? `${text.slice(0, maxLength - 3)}...` : text;

// Discord rejects the whole autocomplete response if any choice name or value exceeds 100 characters.
export const DISCORD_CHOICE_MAX_LENGTH = 100;

export const toDiscordAutocompleteChoices = <T extends {name: string; value: string | number}>(choices: readonly T[]): T[] => choices
  // A value is the submitted query itself, so it cannot be shortened without changing it.
  .filter(choice => typeof choice.value !== 'string' || choice.value.length <= DISCORD_CHOICE_MAX_LENGTH)
  .map(choice => ({...choice, name: truncate(choice.name, DISCORD_CHOICE_MAX_LENGTH)}));

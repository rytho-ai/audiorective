import { Channel, type ChannelOptions } from "../src";

/** The Boolean control has one spelling in options and the existing Param registry. */
export function channelMutedContract(context: BaseAudioContext): void {
  const options: ChannelOptions = { muted: true };
  const channel = new Channel(context, options);
  channel.params.muted.value = false;
  const muted: boolean = channel.params.muted.value;
  channel.params.muted.value = muted;
  // @ts-expect-error The former Boolean option is removed.
  const formerOptions: ChannelOptions = { mute: true };
  void formerOptions;
  // @ts-expect-error The former Param is removed rather than aliased.
  void channel.params.mute;
  channel.dispose();
}

/**
 * 「网易云音乐」设置卡：总开关 + 三项开放平台凭证（AppID / AppSecret / 私钥）。
 *
 * 只改本地状态、随「保存」整包写入（与其余全局卡一致）——即时写盘会重启桌面 Helper。
 * 文案用固定中文（不走 locales）：该卡为本地个人功能，避免为它牵动 8 种语言的键集。
 * @module dsh-pet/src/client/settings/music-card
 */
import type { FunctionComponent } from 'react';
import type { SettingsRuntime } from './runtime.ts';
import { INPUT_CLASS, makeUiKit } from './ui.ts';

/** 音乐卡输入。 */
export interface MusicCardProps {
  readonly busy: boolean;
  readonly enabled: boolean;
  readonly appId: string;
  readonly appSecret: string;
  readonly privateKey: string;
  readonly onToggle: (value: boolean) => void;
  readonly onAppId: (value: string) => void;
  readonly onAppSecret: (value: string) => void;
  readonly onPrivateKey: (value: string) => void;
}

/** 造音乐卡。 */
export function makeMusicCard(rt: SettingsRuntime): FunctionComponent<MusicCardProps> {
  const { h } = rt;
  const { cardHead, field } = makeUiKit({ h, t: rt.t });

  /** 文本输入：非受控 + 失焦提交（与 ui.ts 的数字输入同口径，避免受控输入打断编辑）。 */
  const textInput = (value: string, onCommit: (v: string) => void, extra: Record<string, unknown> = {}) =>
    h('input', {
      ...extra,
      type: 'text',
      className: INPUT_CLASS,
      defaultValue: value,
      key: value,
      spellcheck: 'false',
      onBlur: (e: { target: HTMLInputElement }) => {
        const next = e.target.value;
        if (next !== value) onCommit(next);
      },
    });

  return function MusicCard(props: MusicCardProps) {
    const { busy } = props;
    return h('div', {
      className: 'dsh-pet-cfg__card',
      children: [
        cardHead(
          '网易云音乐',
          '控制本机网易云客户端的播放（走 Windows 系统媒体会话），歌词与收藏走网易云开放平台。需要填开放平台应用的 AppID / AppSecret / 私钥；歌词另需在右键菜单「网易云 → 登录网易云」扫码登录。',
        ),
        h('div', {
          className: 'dsh-pet-cfg__row',
          children: h('label', {
            children: [
              h('input', {
                type: 'checkbox',
                checked: props.enabled,
                disabled: busy,
                onChange: (e: { target: HTMLInputElement }) => props.onToggle(e.target.checked),
              }),
              h('span', { children: ' 启用网易云音乐控制条' }),
            ],
          }),
        }),
        field('AppID', textInput(props.appId, props.onAppId, { disabled: busy, placeholder: '开放平台应用的 AppID' })),
        field(
          'AppSecret',
          textInput(props.appSecret, props.onAppSecret, { disabled: busy, placeholder: '应用 Secret' }),
        ),
        field(
          '私钥（PrivateKey）',
          h('textarea', {
            className: INPUT_CLASS,
            rows: 4,
            defaultValue: props.privateKey,
            key: props.privateKey,
            disabled: busy,
            spellcheck: 'false',
            placeholder: 'RSA 私钥（PKCS#8，不含 BEGIN/END 头尾）',
            style: { width: '100%', resize: 'vertical', fontFamily: 'monospace' },
            onBlur: (e: { target: HTMLTextAreaElement }) => {
              const next = e.target.value.trim();
              if (next !== props.privateKey) props.onPrivateKey(next);
            },
          }),
          '只写进用户层配置（~/.dsh/dsh-pet/main-config.jsonc），源码与内置默认里永远为空。',
        ),
      ],
    });
  };
}

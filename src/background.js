import uid from 'uuid';
import { isEmpty } from 'lodash-es';
import { setController, switchNode } from './lib/background-utils';
import './lib/initPolyfills';
import { PopupConnections } from './lib/popup-connection';
import RedirectChainNames from './lib/redirect-chain-names';
import rpcWallet from './lib/rpcWallet';
import TipClaimRelay from './lib/tip-claim-relay';
import { buildTx } from './popup/utils';
import { popupProps } from './popup/utils/config';
import {
  AEX2_METHODS,
  CONNECTION_TYPES,
  DEFAULT_NETWORK,
  HDWALLET_METHODS,
} from './popup/utils/constants';
import { detectConnectionType } from './popup/utils/helper';
import { getPhishingUrls, phishingCheckUrl, setPhishingUrl } from './popup/utils/phishing-detect';
import WalletController from './wallet-controller';
import Logger from './lib/logger';
import { getState } from './store/plugins/persistState';

const controller = new WalletController();
const inBackground = window.location.href.includes('_generated_background_page.html');

if (process.env.IS_EXTENSION && require.main.i === module.id && inBackground) {
  Logger.init({ background: true });
  RedirectChainNames.init();

  setController(controller);

  const postPhishingData = async data => {
    const tabs = await browser.tabs.query({ active: true, currentWindow: true });
    const message = { method: 'phishingCheck', ...data };
    tabs.forEach(({ id }) => browser.tabs.sendMessage(id, message).catch(console.log));
  };

  const openTipPopup = pageUrl => {
    const tipUrl = `/tip?url=${encodeURIComponent(pageUrl)}`;
    const { href } = new URL(`${browser.extension.getURL('./')}popup/popup.html#${tipUrl}`);
    localStorage.setItem('tipUrl', tipUrl);
    browser.windows.create({
      url: href,
      type: 'popup',
      height: 600,
      width: 375,
    });
  };

  browser.runtime.onMessage.addListener(async (msg, sender) => {
    const { method, params, from, type, data, url: tipUrl } = msg;
    if (method === 'phishingCheck') {
      const host = new URL(params.href).hostname;
      let blocked = false;
      const { result } = await phishingCheckUrl(host);
      if (result === 'blocked') {
        const whitelist = getPhishingUrls().filter(url => url === host);
        blocked = !whitelist.length;
      }
      return postPhishingData({
        ...msg,
        data: {
          method,
          extUrl: browser.extension.getURL('./'),
          host,
          href: params.href,
          blocked,
        },
      });
    }

    if (method === 'setPhishingUrl') {
      const urls = getPhishingUrls();
      urls.push(params.hostname);
      setPhishingUrl(urls);
      return true;
    }

    if (method === 'checkHasAccount') {
      const { account } = await getState();
      if (!account || isEmpty(account)) return false;
    }

    if (from === 'content') {
      const [{ url }] = await browser.tabs.query({ active: true, currentWindow: true });
      if (type === 'readDom' && (data.address || data.chainName)) {
        const {
          current: { network },
        } = await getState();
        if (sender.url === url && (DEFAULT_NETWORK && network) === 'Mainnet')
          TipClaimRelay.checkUrlHasBalance(url, data);
      }
      if (type === 'openTipPopup') openTipPopup(tipUrl || url);
    }

    return true;
  });

  const popupConnections = PopupConnections();
  popupConnections.init();
  rpcWallet.init(controller, popupConnections);
  browser.runtime.onConnect.addListener(async port => {
    if (port.sender.id === browser.runtime.id) {
      const connectionType = detectConnectionType(port);
      if (connectionType === CONNECTION_TYPES.EXTENSION) {
        port.onMessage.addListener(async ({ type, payload, uuid }) => {
          if (HDWALLET_METHODS.includes(type)) {
            port.postMessage({ uuid, res: await controller[type](payload) });
          }
          if (AEX2_METHODS[type]) rpcWallet[type](payload);

          if (type === 'SWITCH_NETWORK') {
            await switchNode();
          }
        });
      } else if (connectionType === CONNECTION_TYPES.POPUP) {
        const url = new URL(port.sender.url);
        const id = url.searchParams.get('id');

        popupConnections.addConnection(id, port);
      } else if (connectionType === CONNECTION_TYPES.OTHER) {
        // eslint-disable-next-line no-param-reassign
        port.uuid = uid();
        if (rpcWallet.sdkReady()) {
          rpcWallet.addConnection(port);
        } else {
          rpcWallet.addConnectionToQueue(port);
        }
        port.onDisconnect.addListener(() => {
          rpcWallet.removeConnectionFromQueue(port);
        });
      }
    }
  });

  const contextMenuItem = {
    id: 'superheroTip',
    title: 'Tip',
  };

  browser.contextMenus.removeAll();
  browser.contextMenus.create(contextMenuItem);
  browser.contextMenus.onClicked.addListener(({ menuItemId, pageUrl }) => {
    if (menuItemId === 'superheroTip') openTipPopup(pageUrl);
  });
}

// eslint-disable-next-line import/prefer-default-export
export const handleMessage = ({ type, payload }) => {
  if (HDWALLET_METHODS.includes(type)) {
    return controller[type](payload);
  }

  if (process.env.RUNNING_IN_TESTS) {
    if (type === 'POPUP_INFO') {
      if (payload.txType) {
        const props = popupProps.base;
        props.action.params.tx = buildTx(payload.txType).tx;
        return props;
      }
      return popupProps[payload.popupType];
    }
    if (['ACTION_DENY', 'ACTION_ACCEPT'].includes(type)) {
      return 'send';
    }
  }

  throw new Error(`Unknown message type: ${type}`);
};

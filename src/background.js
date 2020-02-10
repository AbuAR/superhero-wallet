import { setInterval } from 'timers';
import './lib/initPolyfills';
import { phishingCheckUrl, getPhishingUrls, setPhishingUrl } from './popup/utils/phishing-detect';
import { detectBrowser, extractHostName, detectConnectionType } from './popup/utils/helper';
import WalletContorller from './wallet-controller';
import Notification from './notifications';
import rpcWallet from './lib/rpcWallet';
import { HDWALLET_METHODS, AEX2_METHODS, NOTIFICATION_METHODS, CONNECTION_TYPES } from './popup/utils/constants';
import TipClaimRelay from './lib/tip-claim-relay';
import { setController } from './lib/background-utils';
import { PopupConnections } from './lib/popup-connection';

const controller = new WalletContorller();

if (process.env.IS_EXTENSION) {
  setInterval(() => {
    browser.windows.getAll({}).then(wins => {
      if (wins.length == 0) {
        sessionStorage.removeItem('phishing_urls');
        browser.storage.local.remove('isLogged');
        browser.storage.local.remove('activeAccount');
      }
    });
  }, 5000);

  const notification = new Notification();
  // rpcWallet.init(controller);
  // setController(controller);
  browser.runtime.onMessage.addListener(async (msg, sender, sendResponse) => {
    switch (msg.method) {
      case 'phishingCheck':
        const data = { ...msg, extUrl: browser.extension.getURL('./') };
        const host = extractHostName(msg.params.href);
        data.host = host;
        phishingCheckUrl(host).then(res => {
          if (typeof res.result !== 'undefined' && res.result == 'blocked') {
            const whitelist = getPhishingUrls().filter(url => url === host);
            if (whitelist.length) {
              data.blocked = false;
              return postPhishingData(data);
            }
            data.blocked = true;
            return postPhishingData(data);
          }
          data.blocked = false;
          return postPhishingData(data);
        });
        break;
      case 'setPhishingUrl':
        const urls = getPhishingUrls();
        urls.push(msg.params.hostname);
        setPhishingUrl(urls);
        break;
    }

    if (typeof msg.from !== 'undefined' && typeof msg.type !== 'undefined' && msg.from == 'content' && msg.type == 'readDom' && msg.data.length) {
      const tabs = await browser.tabs.query({ active: true, currentWindow: true });
      tabs.forEach(({ title, url }) => {
        if (sender.url == url) {
          TipClaimRelay.checkUrlHasBalance(url, msg.data);
        }
      });
    }

    return true;
  });

  const postPhishingData = data => {
    browser.tabs.query({ active: true, currentWindow: true }).then(tabs => {
      const message = { method: 'phishingCheck', data };
      tabs.forEach(({ id }) => browser.tabs.sendMessage(id, message));
    });
  };

  const popupConnections = PopupConnections();
  popupConnections.init();
  rpcWallet.init(controller, popupConnections);
  browser.runtime.onConnect.addListener(async port => {
    if (port.sender.id == browser.runtime.id) {
      const connectionType = detectConnectionType(port);
      if (connectionType == CONNECTION_TYPES.EXTENSION) {
        port.onMessage.addListener(({ type, payload, uuid }, sender) => {
          console.log(type);
          console.log(payload);
          if (HDWALLET_METHODS.includes(type)) {
            controller[type](payload).then(res => {
              port.postMessage({ uuid, res });
            });
          }
          if (AEX2_METHODS.hasOwnProperty(type)) {
            rpcWallet[type](payload);
          }
          if (NOTIFICATION_METHODS.hasOwnProperty(type)) {
            notification[type](payload);
          }
        });
      } else if (connectionType == CONNECTION_TYPES.POPUP) {
        const url = new URL(port.sender.url);
        const id = url.searchParams.get('id');

        popupConnections.addConnection(id, port);
      } else if (connectionType == CONNECTION_TYPES.OTHER) {
        const check = rpcWallet.sdkReady(() => {
          rpcWallet.addConnection(port);
        });
        port.onDisconnect.addListener(p => {
          clearInterval(check);
        });
      }
    }
  });
} else {
  window.addEventListener('message', event => {
    if (event.source !== window.parent) return;
    const { type, payload, uuid } = event.data;
    if (HDWALLET_METHODS.includes(type)) {
      controller[type](payload).then(res => {
        window.parent.postMessage({ uuid, res }, window.location.origin);
      });
    }
  });
}

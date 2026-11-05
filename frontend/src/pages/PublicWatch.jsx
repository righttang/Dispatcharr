import React from 'react';
import MobileChannels from '../components/MobileChannels';

export default function PublicWatch() {
  return <div className="public-watch-page">
    <header className="public-watch-header">
      <a href="/channels" className="mobile-brand">电视直播</a>
      <a href="/login?next=%2Fchannels" className="public-watch-login">登录管理</a>
    </header>
    <MobileChannels publicView />
  </div>;
}

/*
 * SPDX-License-Identifier: GPL-3.0-only
 *
 * See jsrpcchannel.h. Message dispatch follows muse::audio::rpc::GeneralRpcChannel
 * and the msgpack framing follows upstream's WebRpcChannel (both muse_framework,
 * Copyright (C) MuseScore Limited and others, GPL-3.0-only).
 */
#include "jsrpcchannel.h"

#include <emscripten.h>
#include <vector>

#include "global/serialization/msgpack.h"

#include "log.h"

using namespace muse;
using namespace muse::audio::rpc;
using namespace mss;

EM_JS(void, mss_js_rpc_send, (const uint8_t* ptr, size_t len), {
    Module["rpcSend"](HEAPU8.slice(ptr, ptr + len));
});

extern "C" EMSCRIPTEN_KEEPALIVE void mss_rpc_receive(const uint8_t* ptr, size_t len)
{
    JsRpcChannel::instance()->receive(ptr, len);
}

JsRpcChannel* JsRpcChannel::instance()
{
    static JsRpcChannel* ch = new JsRpcChannel();
    return ch;
}

void JsRpcChannel::send(const Msg& msg, const ResponseHandler& onResponse)
{
    if (onResponse) {
        m_onResponses[msg.callId] = onResponse;
    }

    static std::vector<uint8_t> buffer;
    buffer.clear();
    buffer.reserve(msg.data.size() + 64);
    msgpack::pack(buffer, msg.ctxId, msg.callId, (uint8_t)msg.code, (uint8_t)msg.type, msg.data.constVData());

    mss_js_rpc_send(buffer.data(), buffer.size());
}

void JsRpcChannel::receive(const uint8_t* data, size_t size)
{
    IF_ASSERT_FAILED(data && size > 0) {
        return;
    }

    msgpack::Cursor cursor(data, size);
    Msg msg;
    uint8_t code = 0;
    uint8_t type = 0;
    msgpack::unpack(cursor, msg.ctxId, msg.callId, code, type, msg.data.vdata());
    msg.code = static_cast<MsgCode>(code);
    msg.type = static_cast<MsgType>(type);

    receive(msg);
}

void JsRpcChannel::receive(const Msg& m)
{
    switch (m.type) {
    case MsgType::Stream: {
        auto it = m_onStreams.find(m.callId);
        if (it != m_onStreams.end() && it->second) {
            it->second(m);
        }
    } break;
    case MsgType::Request: {
        auto it = m_onRequests.find({ m.ctxId, m.code });
        if (it != m_onRequests.end() && it->second) {
            Msg resp = it->second(m);
            if (resp.type != MsgType::ResponseDelayed) {
                send(resp);
            }
        } else {
            LOGW() << "no handler for request: " << to_string(m.code);
        }
    } break;
    case MsgType::Response: {
        auto it = m_onResponses.find(m.callId);
        if (it != m_onResponses.end()) {
            ResponseHandler h = it->second;
            m_onResponses.erase(it);
            if (h) {
                h(m);
            }
        }
    } break;
    case MsgType::Notification: {
        auto it = m_onNotifications.find({ m.ctxId, m.code });
        if (it != m_onNotifications.end() && it->second) {
            it->second(m);
        }
    } break;
    default:
        break;
    }
}

void JsRpcChannel::onRequest(CtxId ctxId, MsgCode code, RequestHandler h)
{
    m_onRequests[{ ctxId, code }] = h;
}

void JsRpcChannel::onNotification(CtxId ctxId, MsgCode code, NotificationHandler h)
{
    m_onNotifications[{ ctxId, code }] = h;
}

void JsRpcChannel::sendStream(const StreamMsg& msg)
{
    send(msg);
}

void JsRpcChannel::addStream(std::shared_ptr<IRpcStream> s)
{
    s->init();
    m_streams.insert({ s->streamId(), s });
}

void JsRpcChannel::removeStream(StreamId id)
{
    m_streams.erase(id);
}

void JsRpcChannel::onStream(StreamId id, StreamHandler h)
{
    m_onStreams[id] = h;
}

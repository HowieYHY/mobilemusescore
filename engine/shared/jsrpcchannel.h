/*
 * SPDX-License-Identifier: GPL-3.0-only
 *
 * MuseScore's audio RPC channel, carried over a JavaScript MessagePort.
 *
 * Both halves (the score module on the page and the audio engine in the
 * AudioWorklet) run one instance each. Outgoing messages are msgpack-encoded
 * and handed to Module.rpcSend(Uint8Array); incoming ones arrive through the
 * exported <prefix>_rpc_receive(ptr, len).
 *
 * Follows muse::audio::rpc::GeneralRpcChannel (muse_framework, GPL-3.0-only);
 * upstream's WebRpcChannel predates the context-aware IRpcChannel interface.
 */
#pragma once

#include <map>
#include <memory>

#include "audio/common/rpc/irpcchannel.h"

namespace mss {
class JsRpcChannel : public muse::audio::rpc::IRpcChannel
{
public:
    static JsRpcChannel* instance();

    void setupOnMain() override {}
    void setupOnEngine() override {}
    void process() override {}

    void send(const muse::audio::rpc::Msg& msg, const muse::audio::rpc::ResponseHandler& onResponse = nullptr) override;
    void onRequest(muse::audio::rpc::CtxId ctxId, muse::audio::rpc::MsgCode code, muse::audio::rpc::RequestHandler h) override;
    void onNotification(muse::audio::rpc::CtxId ctxId, muse::audio::rpc::MsgCode code,
                        muse::audio::rpc::NotificationHandler h) override;

    void addStream(std::shared_ptr<muse::audio::rpc::IRpcStream> s) override;
    void removeStream(muse::audio::rpc::StreamId id) override;
    void sendStream(const muse::audio::rpc::StreamMsg& msg) override;
    void onStream(muse::audio::rpc::StreamId id, muse::audio::rpc::StreamHandler h) override;

    void receive(const uint8_t* data, size_t size);

private:
    void receive(const muse::audio::rpc::Msg& m);

    std::map<muse::audio::rpc::MsgKey, muse::audio::rpc::RequestHandler> m_onRequests;
    std::map<muse::audio::rpc::CallId, muse::audio::rpc::ResponseHandler> m_onResponses;
    std::map<muse::audio::rpc::MsgKey, muse::audio::rpc::NotificationHandler> m_onNotifications;
    std::map<muse::audio::rpc::StreamId, std::shared_ptr<muse::audio::rpc::IRpcStream> > m_streams;
    std::map<muse::audio::rpc::StreamId, muse::audio::rpc::StreamHandler> m_onStreams;
};
}

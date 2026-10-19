import { signAccountContentKeyBindingV1 } from "@happier-dev/protocol/crypto/accountContentKeyBindingV1";
import tweetnacl from "tweetnacl";

export function createSignedAccountContentBinding(
    recipientPublicKey: Uint8Array = tweetnacl.box.keyPair().publicKey,
): Readonly<{
    publicKey: string;
    contentPublicKey: Uint8Array<ArrayBuffer>;
    contentPublicKeySig: Uint8Array<ArrayBuffer>;
}> {
    const signing = tweetnacl.sign.keyPair();
    const contentPublicKey = new Uint8Array(recipientPublicKey);
    return {
        publicKey: Buffer.from(signing.publicKey).toString("hex"),
        contentPublicKey,
        contentPublicKeySig: signAccountContentKeyBindingV1({
            accountSigningSecretKey: signing.secretKey,
            contentPublicKey,
        }),
    };
}
